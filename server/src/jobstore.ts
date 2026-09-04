// Durable job record in Supabase (PostgREST over fetch, service key). The
// in-memory registry in jobs.ts is the live truth; this table is the record a
// reloaded client re-attaches to (GET /jobs, GET /jobs/:id/stream) and the boot
// sweep reconciles. EVERY call is best-effort: Supabase being slow or
// unreachable must never block or crash live work — we log and move on. Covers
// insert / update / get / list / interrupt over the jobs table.

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? "";
const TABLE = "agent_keyboard_jobs";
const MAX_JSONB = 400_000; // cap a pathological status_line/result/error before persisting

export type JobStatus = "queued" | "running" | "done" | "error" | "interrupted";

export interface JobRow {
  job_id: string;
  site_id: string;
  kind: string;
  status: JobStatus;
  status_line: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  prompt: string | null;
  page: string | null;
  created_at: string | null;
  updated_at: string | null;
}

function configured(): boolean {
  return Boolean(SUPABASE_URL && SERVICE_KEY);
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

/** Shrink a jsonb payload that's too large to persist (the live tail already delivered it). */
function capJson<T extends Record<string, unknown> | null>(val: T): T {
  if (val == null) return val;
  try {
    if (JSON.stringify(val).length > MAX_JSONB) {
      return {
        truncated: true,
        detail: "Payload too large to persist; it was delivered on the live stream.",
      } as unknown as T;
    }
  } catch {
    /* non-serializable — leave it, PostgREST will reject and we swallow */
  }
  return val;
}

async function req(path: string, init: RequestInit): Promise<Response | null> {
  if (!configured()) return null;
  try {
    return await fetch(`${SUPABASE_URL}/rest/v1/${path}`, init);
  } catch (err) {
    console.error("[jobstore] request failed:", String(err));
    return null;
  }
}

export async function insertJob(row: {
  jobId: string;
  siteId: string;
  kind: string;
  prompt: string;
  page: string;
}): Promise<void> {
  const res = await req(TABLE, {
    method: "POST",
    headers: headers({ Prefer: "resolution=ignore-duplicates,return=minimal" }),
    body: JSON.stringify({
      job_id: row.jobId,
      site_id: row.siteId,
      kind: row.kind,
      status: "queued",
      status_line: { phase: "queued", detail: "Waiting for a free slot" },
      prompt: row.prompt.slice(0, 20_000),
      page: row.page,
    }),
  });
  if (res && !res.ok) console.error("[jobstore] insertJob", res.status, await res.text().catch(() => ""));
}

export async function updateJob(
  jobId: string,
  fields: {
    status?: JobStatus;
    statusLine?: Record<string, unknown> | null;
    result?: Record<string, unknown> | null;
    error?: Record<string, unknown> | null;
  },
): Promise<void> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (fields.status !== undefined) patch.status = fields.status;
  if (fields.statusLine !== undefined) patch.status_line = capJson(fields.statusLine);
  if (fields.result !== undefined) patch.result = capJson(fields.result);
  if (fields.error !== undefined) patch.error = capJson(fields.error);
  const res = await req(`${TABLE}?job_id=eq.${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    headers: headers({ Prefer: "return=minimal" }),
    body: JSON.stringify(patch),
  });
  if (res && !res.ok) console.error("[jobstore] updateJob", res.status, await res.text().catch(() => ""));
}

export async function getJob(jobId: string): Promise<JobRow | null> {
  const res = await req(`${TABLE}?job_id=eq.${encodeURIComponent(jobId)}&limit=1`, {
    method: "GET",
    headers: headers(),
  });
  if (!res || !res.ok) return null;
  const rows = (await res.json().catch(() => [])) as JobRow[];
  return rows[0] ?? null;
}

/** Active jobs + a 10-minute catch-up window of finished ones, for one site. */
export async function listJobs(siteId: string): Promise<JobRow[]> {
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const filter =
    `site_id=eq.${encodeURIComponent(siteId)}` +
    `&or=(status.eq.queued,status.eq.running,updated_at.gt.${encodeURIComponent(since)})` +
    `&order=created_at.desc&limit=50`;
  const res = await req(`${TABLE}?${filter}`, { method: "GET", headers: headers() });
  if (!res || !res.ok) return [];
  return (await res.json().catch(() => [])) as JobRow[];
}

/**
 * Rows still queued/running that provably did no work before the process died: never
 * past the site-lock queue or the checkout sync, so the CLI never spawned and
 * re-running the prompt verbatim cannot duplicate anything. ('starting' and
 * later phases may have side effects — those stay interrupted.) Read BEFORE the
 * boot sweep flips them to interrupted; the caller re-enqueues them.
 */
export async function listRequeueableJobs(): Promise<JobRow[]> {
  const phases = `or=(status_line.is.null,status_line->>phase.eq.queued,status_line->>phase.eq.syncing)`;
  // Rows a dead process left active (crash / sleep — never got a terminal write).
  // `running` covers rows written by older server versions too.
  const live = `status=in.(queued,running)&kind=eq.message&${phases}&order=created_at.asc&limit=50`;
  // Rows a GRACEFUL shutdown interrupted before they ever started: a deploy
  // marks every running row interrupted, which would silently orphan queued
  // work, so the sweep also rescues recent never-started interrupted rows —
  // unless an earlier sweep already re-entered them (error.kind 'requeued').
  // The 30-minute window bounds how far back a boot can resurrect.
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const dead =
    `status=eq.interrupted&kind=eq.message&${phases}` +
    `&updated_at=gte.${encodeURIComponent(since)}` +
    `&or=(error.is.null,error->>kind.neq.requeued)` +
    `&order=created_at.asc&limit=50`;
  // Scheduled phases ("[scheduled…" prompts) are idempotent by design: they drive
  // off the ledger and crash-recover via Gmail, so a deploy must never drop one
  // mid-run — rescue them whatever phase they reached (owner, 2026-09-04).
  const sched =
    `status=in.(queued,running,interrupted)&kind=eq.message&prompt=like.%5Bscheduled*` +
    `&updated_at=gte.${encodeURIComponent(since)}` +
    `&or=(error.is.null,error->>kind.neq.requeued)` +
    `&order=created_at.asc&limit=50`;
  const [liveRes, deadRes, schedRes] = await Promise.all([
    req(`${TABLE}?${live}`, { method: "GET", headers: headers() }),
    req(`${TABLE}?${dead}`, { method: "GET", headers: headers() }),
    req(`${TABLE}?${sched}`, { method: "GET", headers: headers() }),
  ]);
  const rows: JobRow[] = [];
  const seen = new Set<string>();
  for (const res of [liveRes, deadRes, schedRes]) {
    if (!res || !res.ok) continue;
    for (const r of (await res.json().catch(() => [])) as JobRow[]) {
      if (seen.has(r.job_id)) continue;
      seen.add(r.job_id);
      rows.push(r);
    }
  }
  return rows.filter((r) => r.prompt);
}

/** Boot sweep: after a dead job's prompt re-enters the queue, tag its old row
 *  so a later sweep never rescues the same row twice. */
export async function markRequeued(jobId: string): Promise<void> {
  await updateJob(jobId, {
    error: { kind: "requeued", detail: "Re-entered by the boot sweep after a redeploy." },
  });
}

/**
 * Boot sweep: anything still queued/running predates this process (the machine
 * slept / restarted mid-job). Mark it interrupted so no client hangs on it.
 * Tolerates an unreachable Supabase (logs and returns).
 */
export async function interruptRunningJobs(): Promise<void> {
  const res = await req(`${TABLE}?status=in.(queued,running)`, {
    method: "PATCH",
    headers: headers({ Prefer: "return=minimal" }),
    body: JSON.stringify({
      status: "interrupted",
      updated_at: new Date().toISOString(),
      error: { kind: "interrupted", detail: "The server restarted before this job finished." },
    }),
  });
  if (res && !res.ok) console.error("[jobstore] interruptRunningJobs", res.status);
}
