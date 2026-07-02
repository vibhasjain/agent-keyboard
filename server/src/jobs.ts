// Durable jobs: in-flight Claude work outlives the HTTP connection that started
// it. A job drains one runMessageJob generator to completion no matter who is
// watching; the HTTP layer only ever TAILS a job. The in-memory registry is the
// live truth (single machine, single process); the agent_keyboard_jobs table is
// the durable record a reloaded client re-attaches to.

import { randomBytes } from "node:crypto";
import type { Frame } from "./claude.js";
import { insertJob, updateJob, type JobStatus } from "./jobstore.js";

const TERMINAL = new Set<JobStatus>(["done", "error", "interrupted"]);
const DB_THROTTLE_MS = 2_000;
const RETENTION_MS = 15 * 60_000; // finished jobs linger 15 min for cheap re-attach
const IDEM_TTL_MS = 10 * 60_000;
const MAX_CONCURRENT = 2; // each job is a Claude CLI subprocess

export interface JobSnapshot {
  job_id: string;
  site_id: string;
  kind: string;
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
  status: JobStatus;
  statusLine: Record<string, unknown>;
  lastAssistant: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  subscribers: Set<SubQueue>;
  lastDbWrite: number;
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

// ─── global concurrency: at most MAX_CONCURRENT drains at once ─────────────
class Semaphore {
  private permits: number;
  private waiters: (() => void)[] = [];
  constructor(n: number) {
    this.permits = n;
  }
  async acquire(): Promise<() => void> {
    if (this.permits > 0) this.permits--;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const w = this.waiters.shift();
      if (w) w(); // hand the permit straight to the next waiter
      else this.permits++;
    };
  }
}
const sem = new Semaphore(MAX_CONCURRENT);

const registry = new Map<string, Job>();
const idem = new Map<string, { jobId: string; at: number }>();

function snapshot(job: Job): JobSnapshot {
  return {
    job_id: job.jobId,
    site_id: job.siteId,
    kind: job.kind,
    status: job.status,
    status_line: job.statusLine,
    result: job.result,
    error: job.error,
    created_at: new Date(job.createdAt).toISOString(),
    updated_at: new Date(job.updatedAt).toISOString(),
  };
}

function terminalFrame(job: Job): Frame {
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
  const releaseSem = await sem.acquire();
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
      } else if (event === "error") {
        job.error = payload as Record<string, unknown>;
        job.status = "error";
        publish(job, event, payload);
        break;
      } else if (event === "result") {
        job.result = payload as Record<string, unknown>;
        job.status = "done";
        publish(job, event, payload);
        break;
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
      // Generator ended without a terminal frame — a job must never end silently.
      job.error = { kind: "job_failed", detail: "The job ended without producing a result." };
      job.status = "error";
      publish(job, "error", job.error);
    }
    closeSubscribers(job);
    job.updatedAt = Date.now();
    await flush(job);
    releaseSem();
    const t = setTimeout(() => registry.delete(job.jobId), RETENTION_MS);
    t.unref?.();
  }
}

/**
 * Register and launch a job. Inserts the DB row BEFORE the drain starts so a GET
 * right after this resolves finds the row; the drain then runs fire-and-forget.
 */
export async function startJob(opts: {
  siteId: string;
  kind?: string;
  prompt: string;
  page: string;
  gen: AsyncGenerator<Frame>;
  idemKey?: string;
}): Promise<Job> {
  const now = Date.now();
  const jobId = `job-${now}${randomBytes(2).toString("hex")}`;
  const job: Job = {
    jobId,
    kind: opts.kind ?? "message",
    siteId: opts.siteId,
    status: "running",
    statusLine: { phase: "queued", detail: "Waiting for a free slot" },
    lastAssistant: null,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    subscribers: new Set(),
    lastDbWrite: 0,
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

  void drain(job, opts.gen);
  return job;
}

/**
 * One viewer's tail: a `job` identity frame, a replay of current state, then live
 * frames until the terminal one. Detaching removes only this queue. The subscriber
 * is registered with NO await between the terminal check and the add, so no
 * terminal publish can slip past a live tail.
 */
export async function* tail(job: Job): AsyncGenerator<Frame> {
  yield ["job", { job_id: job.jobId, target: job.siteId, status: job.status }];
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
    for (;;) {
      const item = await q.get();
      if (item === null) {
        // Closed without a terminal frame reaching this queue: synthesize it.
        yield terminalFrame(job);
        return;
      }
      yield item;
      if (item[0] === "result" || item[0] === "error") return;
    }
  } finally {
    job.subscribers.delete(q);
  }
}

export function getJob(jobId: string): Job | null {
  return registry.get(jobId) ?? null;
}

export function jobSnapshot(jobId: string): JobSnapshot | null {
  const job = registry.get(jobId);
  return job ? snapshot(job) : null;
}

export function listActive(siteId?: string): JobSnapshot[] {
  const out: JobSnapshot[] = [];
  for (const job of registry.values()) {
    if (!siteId || job.siteId === siteId) out.push(snapshot(job));
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
