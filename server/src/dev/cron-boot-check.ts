// Regression check for the "a restart silently skipped a day" class of bug
// (cron.ts:6, observed 2026-08-15; re-reported 2026-09-09). Boots a fake clock
// at 03:05:21Z with the real cv-jobs knob set — five entries, linkedin paused,
// state files stamped with yesterday's fires — and asserts that the 06:00
// America/New_York slot still fires that morning, exactly once.
// Run: `npx tsx src/dev/cron-boot-check.ts`.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const BOOT = Date.parse("2026-09-09T03:05:21Z"); // the deploy restart
let now = BOOT;
const realNow = Date.now;
Date.now = () => now; // cron.ts reads startedAt at import, so patch first

const root = await mkdtemp(join(tmpdir(), "agent-keyboard-cron-boot-"));
process.env.AGENT_DATA_DIR = root;
process.env.AK_INTERNAL_SECRET = "test-secret";
process.env.JOBS_CRONS = "[]"; // no env schedules: the knob is the schedule
process.env.SITES = JSON.stringify([
  { id: "cv-jobs", repo: "https://github.com/example/cv-jobs.git", branch: "main", domain: "jobs.example.com" },
]);

// Capture enqueues instead of POSTing to the server.
const fired: { site: string; page: string; at: string }[] = [];
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as { page?: string };
  fired.push({ site: String(url).split("/sites/")[1]?.split("/")[0] ?? "", page: body.page ?? "", at: new Date(now).toISOString() });
  return { ok: true, status: 200, statusText: "OK", body: null } as unknown as Response;
}) as typeof fetch;

const { effectiveJobs, loadCronJobs, tickAll } = await import("../cron.js");

const settings = {
  cron: [
    { id: "apply", prompt: "[scheduled] apply", hour: 6, tz: "America/New_York", page: "/jobs", fresh: true },
    { id: "linkedin", prompt: "[scheduled] linkedin", hour: 14, tz: "America/New_York", page: "/jobs", disabled: true },
    { id: "inbox-noon", prompt: "[scheduled] inbox", hour: 12, tz: "America/New_York", page: "/jobs" },
    { id: "inbox-evening", prompt: "[scheduled] inbox", hour: 18, tz: "America/New_York", page: "/jobs" },
    { id: "inbox-night", prompt: "[scheduled] inbox", hour: 22, tz: "America/New_York", page: "/jobs" },
  ],
};
const settingsPath = join(root, "agent-keyboard", "sites", "cv-jobs", "settings.json");
await mkdir(dirname(settingsPath), { recursive: true });
await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

// Yesterday's fires, exactly as the volume had them at the restart.
const stamps: Record<string, string> = {
  "cron-cv-jobs-apply.json": "2026-09-08T10:04:02.519Z",
  "cron-cv-jobs-inbox-noon.json": "2026-09-08T16:04:02.717Z",
  "cron-cv-jobs-inbox-evening.json": "2026-09-08T22:49:02.937Z",
  "cron-cv-jobs-inbox-night.json": "2026-09-09T02:04:03.001Z",
  "cron-cv-jobs-linkedin.json": "2026-09-08T18:04:02.782Z",
};
for (const [file, lastRunAt] of Object.entries(stamps)) {
  await writeFile(join(root, "agent-keyboard", file), `${JSON.stringify({ lastRunAt }, null, 1)}\n`, "utf8");
}

const envJobs = loadCronJobs();
const cycle = async (at: string) => {
  now = Date.parse(at);
  await tickAll(await effectiveJobs(envJobs));
};

// 1. Inside the boot grace: nothing fires, however overdue anything looks.
await cycle("2026-09-09T03:06:00Z");
assert.equal(fired.length, 0, "nothing may fire during the boot grace");

// 2. After the grace but before the slot: still nothing.
await cycle("2026-09-09T03:10:00Z");
await cycle("2026-09-09T09:55:00Z");
assert.equal(fired.length, 0, "nothing is due before 10:00Z");

// 3. THE REGRESSION: the 06:00 ET slot fires the morning after a 03:05Z restart.
await cycle("2026-09-09T10:00:30Z");
assert.equal(fired.length, 1, `expected exactly the apply fire, got ${JSON.stringify(fired)}`);
assert.deepEqual({ site: fired[0]!.site, page: fired[0]!.page }, { site: "cv-jobs", page: "/jobs" });
const stamped = JSON.parse(await readFile(join(root, "agent-keyboard", "cron-cv-jobs-apply.json"), "utf8")) as { lastRunAt: string };
assert.equal(stamped.lastRunAt, "2026-09-09T10:00:30.000Z", "the fire must stamp today's run");

// 4. Idempotent: the same slot never fires twice.
await cycle("2026-09-09T10:05:00Z");
await cycle("2026-09-09T13:00:00Z");
assert.equal(fired.length, 1, "today's slot must fire once");

// 5. A paused entry stays paused through its slot; live ones still fire.
await cycle("2026-09-09T16:00:30Z"); // inbox-noon (12:00 ET)
await cycle("2026-09-09T18:00:30Z"); // linkedin's 14:00 ET slot — disabled
assert.equal(fired.length, 2, `only inbox-noon may join apply, got ${JSON.stringify(fired)}`);

// 6. Late tick: a machine that was down across a slot fires as soon as it is
//    back, rather than waiting for tomorrow (this is the skipped-day bug).
await cycle("2026-09-09T23:30:00Z"); // 90 minutes past inbox-evening's 18:00 ET slot
assert.equal(fired.length, 3, `a missed slot must be caught up, not skipped: ${JSON.stringify(fired)}`);
assert.deepEqual(
  fired.map((f) => f.at),
  ["2026-09-09T10:00:30.000Z", "2026-09-09T16:00:30.000Z", "2026-09-09T23:30:00.000Z"],
);

Date.now = realNow;
console.log("cron-boot-check OK");
