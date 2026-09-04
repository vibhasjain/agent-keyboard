// Integration check for queued-vs-running API state and ordered durable writes.
// Runs the real Express routes with a tiny in-memory PostgREST stand-in:
//   node --import tsx src/dev/jobs-api-check.ts
import assert from "node:assert/strict";

const port = 18_000 + (process.pid % 1_000);
const apiBase = "https://jobs-api-check.supabase.co";
const internalSecret = "jobs-api-check-secret";
process.env.PORT = String(port);
process.env.JOBS_CRON_DISABLED = "1";
process.env.AK_MAX_WORKERS = "1";
process.env.AK_INTERNAL_SECRET = internalSecret;
process.env.AGENT_DATA_DIR = `/private/tmp/agent-keyboard-jobs-api-check-${process.pid}`;
process.env.ALLOWED_EMAIL = "owner@example.com";
process.env.SUPABASE_URL = apiBase;
process.env.SUPABASE_ANON_KEY = "anon-check";
process.env.SUPABASE_SERVICE_KEY = "service-check";
process.env.GH_TOKEN = "github-check";
process.env.SITES = JSON.stringify([{
  id: "queue-check",
  repo: "https://github.com/example/queue-check.git",
  branch: "main",
  domain: "queue-check.example.com",
}]);

type StoredRow = Record<string, unknown> & { job_id: string; status: string };
const rows = new Map<string, StoredRow>();
const realFetch = globalThis.fetch;
let delayedAdmissionWrites = 0;

const response = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const rawUrl = input instanceof Request ? input.url : String(input);
  if (!rawUrl.startsWith(`${apiBase}/rest/v1/agent_keyboard_jobs`)) {
    return realFetch(input, init);
  }
  const url = new URL(rawUrl);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
  if (method === "POST") {
    const now = new Date().toISOString();
    const row = { ...body, created_at: now, updated_at: now } as unknown as StoredRow;
    rows.set(row.job_id, row);
    return response(undefined, 201);
  }
  if (method === "PATCH") {
    // Make the admission PATCH conspicuously slower than later work. jobs.ts
    // must serialize per-job writes so it still cannot land after `done`.
    if (
      body.status === "running" &&
      (body.status_line as { detail?: unknown } | undefined)?.detail === "Preparing the site"
    ) {
      delayedAdmissionWrites++;
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    const one = url.searchParams.get("job_id")?.replace(/^eq\./, "");
    const targets = one ? [rows.get(one)].filter(Boolean) as StoredRow[] : [...rows.values()];
    for (const row of targets) Object.assign(row, body);
    return response(undefined, 204);
  }
  if (method === "GET") {
    const one = url.searchParams.get("job_id")?.replace(/^eq\./, "");
    return response(one ? [rows.get(one)].filter(Boolean) : [...rows.values()]);
  }
  return response({ error: "unexpected method" }, 405);
}) as typeof fetch;

const { startJob } = await import("../jobs.js");
await import("../index.js");

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await realFetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      /* server is still binding */
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("server did not start");
}

function fakeJob(holdMs: number) {
  return async function* (release: () => void) {
    try {
      yield ["status", { phase: "syncing", detail: "API check" }] as [string, unknown];
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      yield ["result", { reply: "done" }] as [string, unknown];
    } finally {
      release();
    }
  };
}

await waitForServer();
// Let the no-op boot sweep finish before inserting the rows under test.
await new Promise((resolve) => setTimeout(resolve, 30));
const first = await startJob({
  siteId: "queue-check",
  prompt: "first",
  page: "/",
  makeGen: fakeJob(350),
});
const second = await startJob({
  siteId: "queue-check",
  prompt: "second",
  page: "/",
  makeGen: fakeJob(60),
});

const auth = { "x-ak-internal": internalSecret };
const listRes = await realFetch(`http://127.0.0.1:${port}/jobs?siteId=queue-check`, { headers: auth });
assert.equal(listRes.status, 200);
const list = await listRes.json() as { jobs: Array<{ job_id: string; status: string; status_line: { phase?: string } }> };
const firstRow = list.jobs.find((row) => row.job_id === first.jobId);
const secondRow = list.jobs.find((row) => row.job_id === second.jobId);
assert.equal(firstRow?.status, "running");
assert.notEqual(firstRow?.status_line.phase, "queued");
assert.equal(secondRow?.status, "queued");

const detailRes = await realFetch(`http://127.0.0.1:${port}/jobs/${encodeURIComponent(second.jobId)}`, { headers: auth });
assert.equal(detailRes.status, 200);
const detail = await detailRes.json() as { status: string; status_line: { phase?: string } };
assert.equal(detail.status, "queued");
assert.equal(detail.status_line.phase, "queued");

await new Promise((resolve) => setTimeout(resolve, 1_200));
assert.equal(rows.get(first.jobId)?.status, "done", "slow admission PATCH must not overwrite terminal status");
assert.ok(delayedAdmissionWrites >= 2, "both admissions exercised the delayed write path");

console.log(
  `jobs-api-check OK — GET /jobs: ${firstRow?.status} + ${secondRow?.status}; ` +
  `GET /jobs/:id: ${detail.status}; durable first: ${rows.get(first.jobId)?.status}`,
);
process.exit(0);
