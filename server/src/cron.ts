// Jobs cron — fires one job-hunt cycle every day at a FIXED wall-clock time.
//
// Two earlier designs failed and both lessons are baked in here:
//   1. setInterval(24h) started at boot — a single Fly restart reset the
//      countdown and silently skipped a day (observed 2026-08-15).
//   2. "24h after the last run" — no restart bug, but the run time drifted
//      later every day.
// So: resolve today's target instant in a named timezone (DST-aware), persist
// the last run on the DATA VOLUME, check every few minutes, and fire when today's
// target has passed and we have not run since it — which also catches up a run
// missed while the machine was down.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { listActive } from "./jobs.js";

const STATE_PATH = process.env.JOBS_CRON_STATE ?? "/data/agent-keyboard/jobs-cron.json";
const TZ = process.env.JOBS_CRON_TZ ?? "America/New_York";
const HOUR = Number(process.env.JOBS_CRON_HOUR ?? 11);     // 11:00 local in TZ
const TICK_MS = 5 * 60_000;
const BOOT_GRACE_MS = 2 * 60_000;
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

interface Clock { year: number; month: number; day: number; hour: number; minute: number; second: number }

/** Calendar/clock parts of an instant as seen in TZ. */
function partsIn(instant: Date): Clock {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const m = new Map<string, number>(
    dtf.formatToParts(instant).filter((p) => p.type !== "literal").map((p) => [String(p.type), Number(p.value)]),
  );
  const g = (k: string): number => m.get(k) ?? 0;
  return { year: g("year"), month: g("month"), day: g("day"), hour: g("hour"), minute: g("minute"), second: g("second") };
}

/** TZ offset (ms) at a given instant — positive east of UTC. */
function offsetMs(instant: Date): number {
  const p = partsIn(instant);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - instant.getTime();
}

/** UTC instant of HOUR:00 local, on the TZ calendar day `dayShift` days from now. */
function scheduledInstant(dayShift = 0): number {
  const p = partsIn(new Date(Date.now() + dayShift * 86_400_000));
  const naive = Date.UTC(p.year, p.month - 1, p.day, HOUR, 0, 0);
  // Two passes settles the DST edge cases (the offset depends on the instant).
  let utc = naive - offsetMs(new Date(naive));
  utc = naive - offsetMs(new Date(utc));
  return utc;
}

async function readLastRun(): Promise<number> {
  try {
    const at = Date.parse(JSON.parse(await readFile(STATE_PATH, "utf8"))?.lastRunAt ?? "");
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0;
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

    const target = scheduledInstant();
    if (Date.now() < target) return;              // today's slot hasn't arrived
    const last = await readLastRun();
    if (last >= target) return;                   // already ran for today's slot

    // Never stack cycles — but a job wedged "running" must not silence the
    // schedule forever, so fire anyway once we are a full day past the slot.
    if (listActive(SITE).some((job) => job.status === "running")) {
      if (Date.now() - target < 86_400_000) return;
      console.warn("[jobs-cron] a job is still running but we are a day overdue — firing anyway");
    }

    console.log(
      `[jobs-cron] firing for the ${String(HOUR).padStart(2, "0")}:00 ${TZ} slot ` +
      `(${new Date(target).toISOString()}); last run ${last ? new Date(last).toISOString() : "never"}`,
    );
    await writeLastRun(Date.now());               // stamp first so a crash can't retry-loop
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
  const next = Date.now() < scheduledInstant() ? scheduledInstant() : scheduledInstant(1);
  console.log(
    `[jobs-cron] armed — daily at ${String(HOUR).padStart(2, "0")}:00 ${TZ}, goal ${TARGET} submissions/run; ` +
    `next slot ${new Date(next).toISOString()}; state at ${STATE_PATH}`,
  );
  void tick();
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
}
