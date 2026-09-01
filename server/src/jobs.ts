// Durable jobs: in-flight Claude work outlives the HTTP connection that started
// it. A job drains one runMessageJob generator to completion no matter who is
// watching; the HTTP layer only ever TAILS a job. The in-memory registry is the
// live truth (single machine, single process); the agent_keyboard_jobs table is
// the durable record a reloaded client re-attaches to.
//
// Admission: a submitted job sits in the pending queue holding NO resources
// until the scheduler admits it — admission requires a free worker slot
// (MAX_WORKERS, env AK_MAX_WORKERS) AND its site's lock free right now
// (tryAcquireSiteLock). Same-site jobs therefore serialize on the site lock
// while different sites run in parallel, and a same-site backlog can never
// starve other sites (the old global FIFO semaphore let queued jobs hold
// pool permits while blocked on their site lock). Among admissible jobs the
// scheduler picks the highest `priority` (submit-time flag, default 0 =
// legacy behavior), FIFO on ties.

import { randomBytes } from "node:crypto";
import type { Frame, InputChannel } from "./claude.js";
import { insertJob, updateJob, type JobStatus } from "./jobstore.js";
import { tryAcquireSiteLock } from "./checkouts.js";

const TERMINAL = new Set<JobStatus>(["done", "error", "interrupted"]);
const DB_THROTTLE_MS = 2_000;
const RETENTION_MS = 15 * 60_000; // finished jobs linger 15 min for cheap re-attach
const IDEM_TTL_MS = 10 * 60_000;
// Each admitted job is a Claude CLI subprocess (~500MB); 3 fits the 2GB
// machine + 512MB swap with headroom for headless chromium (cv-jobs worker).
const MAX_WORKERS = Math.max(1, Number(process.env.AK_MAX_WORKERS ?? 3) || 3);

export interface JobSnapshot {
  job_id: string;
  site_id: string;
  kind: string;
  priority: number;
  status: JobStatus;
  status_line: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

interface Job {
  jobId: string;
  kind: string;
  siteId: string;
  priority: number; // submit-time lane: higher runs first among admissible jobs
  admitted: boolean; // false while still in the pending queue (no lock, no CLI)
  pageSlug: string; // conversation dimension: "" = the site root
  status: JobStatus;
  statusLine: Record<string, unknown>;
  lastAssistant: Record<string, unknown> | null;
  lastTodos: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  subscribers: Set<SubQueue>;
  lastDbWrite: number;
  abort: () => void; // signals runMessageJob to kill its CLI child (used by cancelJob)
  streaming: boolean; // long-lived session: a `result` marks a turn boundary, not the end
  input: InputChannel | null; // follow-up injection channel (streaming sessions only)
  conversationId: string | null; // for auto-resume after a self-triggered redeploy
  sessionId: string | null; //     "
  prompt: string; //               the user intent (short-form persisted for resume)
  resumeCount: number; //          how many times this lineage has auto-resumed (loop cap)
}

// ─── a subscriber's frame queue (null = closed) ───────────────────────────
class SubQueue {
  private items: (Frame | null)[] = [];
  private waiters: ((v: Frame | null) => void)[] = [];
  push(item: Frame | null): void {
    const w = this.waiters.shift();
    if (w) w(item);
    else this.items.push(item);
  }
  get(): Promise<Frame | null> {
    if (this.items.length) return Promise.resolve(this.items.shift()!);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

// ─── admission scheduler: at most MAX_WORKERS drains at once, never two on ───
// ─── the same site. Queued jobs hold no slot, so cross-site work never waits ──
// ─── behind one site's backlog. ─────────────────────────────────────────────
interface QueuedJob {
  job: Job;
  makeGen: (preLock: () => void) => AsyncGenerator<Frame>;
}
const pending: QueuedJob[] = [];
let activeWorkers = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function schedule(): void {
  // Reap jobs cancelled before admission (their generator was never created):
  // deliver the terminal frame cancelJob published, persist, and retain.
  for (let i = pending.length - 1; i >= 0; i--) {
    if (!TERMINAL.has(pending[i]!.job.status)) continue;
    const { job } = pending.splice(i, 1)[0]!;
    closeSubscribers(job);
    void flush(job);
    const t = setTimeout(() => registry.delete(job.jobId), RETENTION_MS);
    t.unref?.();
  }
  let admitted = false;
  while (activeWorkers < MAX_WORKERS && pending.length) {
    // Highest priority first, FIFO among equal priorities (pending is already
    // in submit order). Admission is atomic: the first candidate whose site
    // lock is free takes it with the slot, so a same-site runner-up cleanly
    // waits for the next schedule() pass.
    const order = pending
      .map((_, i) => i)
      .sort(
        (a, b) =>
          pending[b]!.job.priority - pending[a]!.job.priority ||
          pending[a]!.job.createdAt - pending[b]!.job.createdAt,
      );
    let picked = false;
    for (const i of order) {
      const preLock = tryAcquireSiteLock(pending[i]!.job.siteId);
      if (!preLock) continue;
      const { job, makeGen } = pending.splice(i, 1)[0]!;
      job.admitted = true;
      activeWorkers++;
      admitted = true;
      picked = true;
      void drain(job, makeGen(preLock));
      break;
    }
    if (!picked) break;
  }
  // tryAcquireSiteLock can lose to a lock released earlier in this same tick
  // (its chain entry outlives release() by a microtask). One short re-check
  // covers that transient; genuine busy-sites are re-driven by drain teardown.
  if (!admitted && pending.length && !retryTimer) {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      schedule();
    }, 25);
    retryTimer.unref?.();
  }
}

const registry = new Map<string, Job>();
const idem = new Map<string, { jobId: string; at: number }>();

function snapshot(job: Job): JobSnapshot {
  return {
    job_id: job.jobId,
    site_id: job.siteId,
    kind: job.kind,
    priority: job.priority,
    status: job.status,
    status_line: job.statusLine,
    result: job.result,
    error: job.error,
    created_at: new Date(job.createdAt).toISOString(),
    updated_at: new Date(job.updatedAt).toISOString(),
  };
}

function terminalFrame(job: Job): Frame {
  // A streaming session that ended emits `closed` (its turns already streamed as
  // per-turn `result` frames); a classic job emits its single terminal result.
  if (job.streaming && job.status === "done") return ["closed", {}];
  if (job.status === "done") return ["result", job.result ?? {}];
  return ["error", job.error ?? { kind: "job_failed", detail: "The job failed." }];
}

function publish(job: Job, event: string, payload: unknown): void {
  for (const q of job.subscribers) q.push([event, payload]);
}

function closeSubscribers(job: Job): void {
  for (const q of job.subscribers) q.push(null);
  job.subscribers.clear();
}

async function flush(job: Job): Promise<void> {
  await updateJob(job.jobId, {
    status: job.status,
    statusLine: job.statusLine,
    result: job.result,
    error: job.error,
  }).catch(() => {});
  job.lastDbWrite = Date.now();
}

async function maybeFlush(job: Job): Promise<void> {
  if (Date.now() - job.lastDbWrite >= DB_THROTTLE_MS) await flush(job);
}

async function drain(job: Job, gen: AsyncGenerator<Frame>): Promise<void> {
  try {
    for await (const [event, payload] of gen) {
      job.updatedAt = Date.now();
      if (event === "status") {
        job.statusLine = payload as Record<string, unknown>;
        publish(job, event, payload);
        await maybeFlush(job);
      } else if (event === "assistant") {
        job.lastAssistant = payload as Record<string, unknown>;
        publish(job, event, payload);
      } else if (event === "todos") {
        // Latest checklist, so a mid-job re-attach can replay it. Live-only:
        // never flushed to the DB, and not replayed once the job is terminal.
        job.lastTodos = payload as Record<string, unknown>;
        publish(job, event, payload);
      } else if (event === "error") {
        job.error = payload as Record<string, unknown>;
        job.status = "error";
        publish(job, event, payload);
        break;
      } else if (event === "result") {
        job.result = payload as Record<string, unknown>;
        publish(job, event, payload);
        if (!job.streaming) {
          job.status = "done";
          break;
        }
        // Streaming session: a turn ended, but the session stays open for more.
        await maybeFlush(job);
      } else {
        publish(job, event, payload);
      }
    }
  } catch (exc) {
    job.error = { kind: "job_failed", detail: `${String((exc as Error)?.message ?? exc)}`.slice(0, 300) };
    job.status = "error";
    publish(job, "error", job.error);
  } finally {
    // Run the generator's own finally (kills the CLI child, releases the site lock).
    try {
      await gen.return(undefined);
    } catch {
      /* ignore */
    }
    if (job.status === "running") {
      if (job.streaming && job.result) {
        // A streaming session closed normally (idle / lifetime cap) after ≥1 turn.
        job.status = "done";
      } else {
        // Generator ended without a terminal frame — a job must never end silently.
        job.error = { kind: "job_failed", detail: "The job ended without producing a result." };
        job.status = "error";
        publish(job, "error", job.error);
      }
    }
    closeSubscribers(job);
    job.updatedAt = Date.now();
    await flush(job);
    activeWorkers--;
    schedule(); // a freed slot (and possibly a freed site) admits the next job
    const t = setTimeout(() => registry.delete(job.jobId), RETENTION_MS);
    t.unref?.();
  }
}

/**
 * Register and queue a job. Inserts the DB row BEFORE admission so a GET right
 * after this resolves finds the row (phase "queued"); the scheduler then admits
 * it when a worker slot and its site lock are both free.
 */
export async function startJob(opts: {
  siteId: string;
  kind?: string;
  prompt: string;
  page: string;
  pageSlug?: string;
  /** Deferred generator construction: the run (and its site lock / CLI spawn)
   *  only exists once the scheduler admits the job. */
  makeGen: (preLock: () => void) => AsyncGenerator<Frame>;
  abort?: () => void;
  idemKey?: string;
  priority?: number;
  streaming?: boolean;
  input?: InputChannel | null;
  conversationId?: string | null;
  sessionId?: string | null;
  resumeCount?: number;
}): Promise<Job> {
  const now = Date.now();
  const jobId = `job-${now}${randomBytes(2).toString("hex")}`;
  const job: Job = {
    jobId,
    kind: opts.kind ?? "message",
    siteId: opts.siteId,
    priority: Math.max(-100, Math.min(100, Math.trunc(opts.priority ?? 0) || 0)),
    admitted: false,
    pageSlug: opts.pageSlug ?? "",
    status: "running",
    statusLine: { phase: "queued", detail: "Waiting for a free slot" },
    lastAssistant: null,
    lastTodos: null,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    subscribers: new Set(),
    lastDbWrite: 0,
    abort: opts.abort ?? (() => {}),
    streaming: opts.streaming ?? false,
    input: opts.input ?? null,
    conversationId: opts.conversationId ?? null,
    sessionId: opts.sessionId ?? null,
    prompt: opts.prompt,
    resumeCount: opts.resumeCount ?? 0,
  };
  registry.set(jobId, job);
  if (opts.idemKey) idem.set(opts.idemKey, { jobId, at: now });

  await insertJob({
    jobId,
    siteId: opts.siteId,
    kind: job.kind,
    prompt: opts.prompt,
    page: opts.page,
  }).catch(() => {});

  pending.push({ job, makeGen: opts.makeGen });
  schedule();
  return job;
}

/**
 * One viewer's tail: a `job` identity frame, a replay of current state, then live
 * frames until the terminal one. Detaching removes only this queue. The subscriber
 * is registered with NO await between the terminal check and the add, so no
 * terminal publish can slip past a live tail.
 */
export async function* tail(job: Job): AsyncGenerator<Frame> {
  yield ["job", { job_id: job.jobId, target: job.siteId, status: job.status, streaming: job.streaming }];
  if (TERMINAL.has(job.status)) {
    if (Object.keys(job.statusLine).length) yield ["status", job.statusLine];
    if (job.lastAssistant) yield ["assistant", job.lastAssistant];
    yield terminalFrame(job);
    return;
  }
  const q = new SubQueue();
  job.subscribers.add(q);
  try {
    if (Object.keys(job.statusLine).length) yield ["status", job.statusLine];
    if (job.lastAssistant) yield ["assistant", job.lastAssistant];
    if (job.lastTodos) yield ["todos", job.lastTodos];
    for (;;) {
      const item = await q.get();
      if (item === null) {
        // Closed without a terminal frame reaching this queue: synthesize it.
        yield terminalFrame(job);
        return;
      }
      yield item;
      // A streaming session emits a `result` per turn but stays open — only end
      // the tail on a real terminal (error, or the synthesized `closed` via null).
      // Ending on every `result` made the stream close + reconnect each turn,
      // which is what surfaced spurious transient errors mid-session.
      if (item[0] === "error") return;
      if (item[0] === "result" && !job.streaming) return;
    }
  } finally {
    job.subscribers.delete(q);
  }
}

export function getJob(jobId: string): Job | null {
  return registry.get(jobId) ?? null;
}

/** Inject a follow-up message into a running streaming session's CLI. Returns
 *  false if the job is unknown, already terminal, or not a streaming session. */
export function appendToJob(jobId: string, text: string): boolean {
  const job = registry.get(jobId);
  if (!job || TERMINAL.has(job.status) || !job.input) return false;
  const ok = job.input.push(text);
  if (ok) job.updatedAt = Date.now();
  return ok;
}

/**
 * Forcefully stop a running job: publish a terminal 'stopped' error to every
 * tail, then signal the run to abort — which SIGKILLs the CLI child, unblocking
 * the generator so it runs its finally (releases the site lock) and ends. No-op
 * (returns false) if the job is unknown or already terminal. The drain loop sees
 * status !== "running" and won't overwrite the stop with a generic failure.
 */
export function cancelJob(jobId: string): boolean {
  const job = registry.get(jobId);
  if (!job || TERMINAL.has(job.status)) return false;
  job.status = "error";
  job.error = { kind: "stopped", detail: "Stopped." };
  job.updatedAt = Date.now();
  publish(job, "error", job.error);
  try {
    job.abort();
  } catch {
    /* best-effort */
  }
  schedule(); // if it was still queued, the reaper finalizes it now
  return true;
}

export function jobSnapshot(jobId: string): JobSnapshot | null {
  const job = registry.get(jobId);
  return job ? snapshot(job) : null;
}

export function listActive(siteId?: string, pageSlug?: string): JobSnapshot[] {
  const out: JobSnapshot[] = [];
  for (const job of registry.values()) {
    if (siteId && job.siteId !== siteId) continue;
    if (pageSlug !== undefined && job.pageSlug !== pageSlug) continue;
    out.push(snapshot(job));
  }
  return out;
}

/**
 * For every still-running job, the minimal shape the auto-resume marker needs so
 * that after a self-triggered redeploy the turn can be picked up where it left
 * off (see resume.ts). Live-registry only — nothing durable.
 */
export function runningResumeInputs(): {
  jobId: string;
  siteId: string;
  pageSlug: string;
  conversationId: string | null;
  sessionId: string | null;
  streaming: boolean;
  prompt: string;
  resumeCount: number;
}[] {
  const out: {
    jobId: string;
    siteId: string;
    pageSlug: string;
    conversationId: string | null;
    sessionId: string | null;
    streaming: boolean;
    prompt: string;
    resumeCount: number;
  }[] = [];
  for (const job of registry.values()) {
    if (job.status !== "running") continue;
    // Only admitted jobs have a live Claude session to resume; queued ones are
    // re-entered verbatim by the boot sweep's requeue instead.
    if (!job.admitted) continue;
    out.push({
      jobId: job.jobId,
      siteId: job.siteId,
      pageSlug: job.pageSlug,
      conversationId: job.conversationId,
      sessionId: job.sessionId,
      streaming: job.streaming,
      prompt: job.prompt,
      resumeCount: job.resumeCount,
    });
  }
  return out;
}

/** Live job for a still-valid idempotency key, or null. Also purges expired keys. */
export function jobForIdem(key: string): Job | null {
  const now = Date.now();
  for (const [k, v] of idem) if (now - v.at > IDEM_TTL_MS) idem.delete(k);
  const hit = idem.get(key);
  if (!hit) return null;
  return registry.get(hit.jobId) ?? null;
}
