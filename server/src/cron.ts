// Jobs cron — fires one job-hunt cycle per day for the cv-jobs worker.
//
// It must survive machine restarts. A naive setInterval(24h) restarts its
// countdown on every boot, so a single Fly restart silently pushes the run to
// 24h later (observed 2026-08-15: a 09:45Z restart moved that day's run and it
// never happened). Instead: persist the last run on the DATA VOLUME, tick every
// few minutes, and fire whenever a run is DUE — including immediately after a
// boot that missed one.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { listActive } from "./jobs.js";

const STATE_PATH = process.env.JOBS_CRON_STATE ?? "/data/agent-keyboard/jobs-cron.json";
const TICK_MS = 5 * 60_000;                       // how often we CHECK (cheap)
const INTERVAL_MS = (() => {                      // how often we RUN
  const n = Number(process.env.JOBS_CRON_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? n : 24 * 3_600_000;
})();
const BOOT_GRACE_MS = 2 * 60_000;                 // let the server settle first
const SITE = process.env.JOBS_CRON_SITE ?? "cv-jobs";
const SECRET = process.env.AK_INTERNAL_SECRET ?? "";
const PORT = Number(process.env.PORT ?? 8080);
const TARGET = Number(process.env.JOBS_CRON_TARGET ?? 10);

const PROMPT =
  `[scheduled] Run one job-hunt cycle. GOAL FOR THIS RUN: ${TARGET} applications actually submitted ` +
  `and verified via cloud/confirmations.py — that is the bar, not "attempted". Open CLOUD_WORKER.md at ` +
  `the root of this checkout and follow it end to end; start with the queue in cloud/state.json ` +
  `readyToSubmit, which holds prepared applications. Every submit runs headed under Xvfb ` +
  `(xvfb-run -a env PLAYWRIGHT_BROWSERS_PATH=/data/pw-browsers APPLY_HEADED=1 …). Pace ~3 per ATS ` +
  `vendor per hour and switch vendors on the first spam refusal. Commit and push after every submit. ` +
  `Reply with: submitted N/${TARGET}, which ATS each, and anything that blocked you.`;

const startedAt = Date.now();

async function readLastRun(): Promise<number> {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const at = Date.parse(JSON.parse(raw)?.lastRunAt ?? "");
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0; // no state yet — treat as "never ran", so the first tick fires
  }
}

async function writeLastRun(when: number): Promise<void> {
  try {
    await mkdir(dirname(STATE_PATH), { recursive: true });
    await writeFile(STATE_PATH, `${JSON.stringify({ lastRunAt: new Date(when).toISOString() }, null, 1)}\n`);
  } catch (err) {
    console.error("[jobs-cron] could not persist state", String(err));
  }
}

async function fire(): Promise<boolean> {
  const res = await fetch(`http://127.0.0.1:${PORT}/sites/${SITE}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ak-internal": SECRET },
    body: JSON.stringify({ text: PROMPT, page: "/jobs" }),
  });
  await res.body?.cancel(); // durable job — don't hold the SSE stream open
  if (!res.ok) {
    console.error(`[jobs-cron] enqueue failed: ${res.status} ${res.statusText}`);
    return false;
  }
  return true;
}

async function tick(): Promise<void> {
  try {
    if (!SECRET) return;
    if (Date.now() - startedAt < BOOT_GRACE_MS) return;
    // A cycle can run for a long time; never stack a second one on top of it.
    if (listActive(SITE).some((job) => job.status === "running")) return;

    const last = await readLastRun();
    const due = Date.now() - last;
    if (due < INTERVAL_MS) return;

    const missed = last > 0 && due > INTERVAL_MS * 1.5;
    console.log(
      `[jobs-cron] firing — last run ${last ? new Date(last).toISOString() : "never"}` +
      `${missed ? " (missed a scheduled run; catching up)" : ""}`,
    );
    // Stamp BEFORE firing: if the cycle itself crashes we still wait a full
    // interval rather than retrying every 5 minutes.
    await writeLastRun(Date.now());
    if (!(await fire())) await writeLastRun(last);
  } catch (err) {
    console.error("[jobs-cron] tick error", String(err));
  }
}

export function startJobsCron(): void {
  if (!SECRET) {
    console.warn("[jobs-cron] AK_INTERNAL_SECRET unset — cron disabled");
    return;
  }
  console.log(
    `[jobs-cron] armed — every ${Math.round(INTERVAL_MS / 3_600_000)}h for ${SITE}, ` +
    `goal ${TARGET} submissions/run, checked every ${TICK_MS / 60_000}m, state at ${STATE_PATH}`,
  );
  void tick();
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
}
