// Jobs cron — fires scheduled prompt cycles; JOBS_CRONS can define several.
// Without JOBS_CRONS, the legacy job-hunt cycle runs daily at a FIXED wall-clock time.
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

import { rotateConversation } from "./claude.js";
import { listActive } from "./jobs.js";
import { getSite, pageSlugFor } from "./sites.js";

const TICK_MS = 5 * 60_000;
const BOOT_GRACE_MS = 2 * 60_000;
const SECRET = process.env.AK_INTERNAL_SECRET ?? "";
const PORT = Number(process.env.PORT ?? 8080);

const startedAt = Date.now();

interface CronJob {
  site: string;
  prompt: string;
  hour: number;
  tz: string;
  everyHours?: number;
  state: string;
  page: string;
  /** Clear the context (fresh session, empty history) right before each run. */
  fresh: boolean;
}

interface Clock { year: number; month: number; day: number; hour: number; minute: number; second: number }

function legacyCronJob(): CronJob {
  const target = Number(process.env.JOBS_CRON_TARGET ?? 10);
  const prompt =
    `[scheduled] Run one job-hunt cycle. DAILY TARGET: ${target} applications submitted and verified via ` +
    `cloud/confirmations.py per America/New_York calendar day, counted across ALL runs that day — not per run. ` +
    `First: \`node cloud/ledger.mjs list --status submitted --json\` and count today's appliedOn; if today already ` +
    `has ${target}, do housekeeping only (triage-queue, Gmail cleanup, stamp) and stop. Otherwise apply only up to ` +
    `the remainder. Open CLOUD_WORKER.md at the root of this checkout and follow it end to end; drain the ledger ` +
    `queue (workable rows) before discovering anything new. Every submit runs headed under Xvfb ` +
    `(xvfb-run -a env PLAYWRIGHT_BROWSERS_PATH=/data/pw-browsers APPLY_HEADED=1 …). Pace ~3 per ATS ` +
    `vendor per hour and switch vendors on the first spam refusal. Commit and push after every submit. ` +
    `Reply with: submitted today N/${target}, which ATS each, and anything that blocked you.`;

  return {
    site: process.env.JOBS_CRON_SITE ?? "cv-jobs",
    prompt,
    hour: Number(process.env.JOBS_CRON_HOUR ?? 11),
    tz: process.env.JOBS_CRON_TZ ?? "America/New_York",
    state: process.env.JOBS_CRON_STATE ?? "/data/agent-keyboard/jobs-cron.json",
    page: "/jobs",
    fresh: false,
  };
}

function invalidCronJobs(location: string, detail: string): CronJob[] {
  console.error(`[jobs-cron] invalid JOBS_CRONS ${location}: ${detail}; using legacy schedule`);
  return [legacyCronJob()];
}

export function loadCronJobs(): CronJob[] {
  const source = process.env.JOBS_CRONS;
  if (!source?.trim()) return [legacyCronJob()];

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    return invalidCronJobs("at root", `malformed JSON (${String(err)})`);
  }
  if (!Array.isArray(parsed)) return invalidCronJobs("at root", "expected an array");

  const jobs: CronJob[] = [];
  for (const [index, raw] of parsed.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return invalidCronJobs(`at index ${index}`, "expected an object");
    }
    const entry = raw as Record<string, unknown>;

    if (entry.disabled !== undefined && typeof entry.disabled !== "boolean") {
      return invalidCronJobs(`at index ${index}, field disabled`, "expected a boolean");
    }
    if (entry.disabled === true) continue;
    if (entry.fresh !== undefined && typeof entry.fresh !== "boolean") {
      return invalidCronJobs(`at index ${index}, field fresh`, "expected a boolean");
    }

    if (typeof entry.site !== "string" || !/^[a-z0-9][a-z0-9-]*$/i.test(entry.site)) {
      return invalidCronJobs(`at index ${index}, field site`, "expected a non-empty slug");
    }
    if (typeof entry.prompt !== "string" || !entry.prompt.trim()) {
      return invalidCronJobs(`at index ${index}, field prompt`, "expected a non-empty string");
    }

    const hour = entry.hour === undefined ? 11 : entry.hour;
    if (typeof hour !== "number" || !Number.isInteger(hour) || hour < 0 || hour > 23) {
      return invalidCronJobs(`at index ${index}, field hour`, "expected an integer from 0 through 23");
    }

    const everyHours = entry.everyHours;
    if (everyHours !== undefined &&
        (typeof everyHours !== "number" || !Number.isFinite(everyHours) || everyHours <= 0)) {
      return invalidCronJobs(`at index ${index}, field everyHours`, "expected a finite number greater than 0");
    }

    const tz = entry.tz === undefined ? "America/New_York" : entry.tz;
    if (typeof tz !== "string" || !tz.trim()) {
      return invalidCronJobs(`at index ${index}, field tz`, "expected a non-empty string");
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz }).format();
    } catch {
      return invalidCronJobs(`at index ${index}, field tz`, "expected a valid time zone");
    }

    const state = entry.state === undefined ? `/data/agent-keyboard/cron-${entry.site}.json` : entry.state;
    if (typeof state !== "string" || !state.trim()) {
      return invalidCronJobs(`at index ${index}, field state`, "expected a non-empty string");
    }

    const page = entry.page === undefined ? "/" : entry.page;
    if (typeof page !== "string" || !page.startsWith("/")) {
      return invalidCronJobs(`at index ${index}, field page`, "expected a non-empty string starting with '/'");
    }

    jobs.push({
      site: entry.site,
      prompt: entry.prompt,
      hour,
      tz,
      ...(everyHours === undefined ? {} : { everyHours }),
      state,
      page,
      fresh: entry.fresh === true,
    });
  }
  return jobs;
}

/** Calendar/clock parts of an instant as seen in a named timezone. */
function partsIn(instant: Date, tz: string): Clock {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
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
function offsetMs(instant: Date, tz: string): number {
  const p = partsIn(instant, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - instant.getTime();
}

/** UTC instant of the job's local hour, on the TZ calendar day `dayShift` days from now. */
function scheduledInstant(job: CronJob, dayShift = 0): number {
  const p = partsIn(new Date(Date.now() + dayShift * 86_400_000), job.tz);
  const naive = Date.UTC(p.year, p.month - 1, p.day, job.hour, 0, 0);
  // Two passes settles the DST edge cases (the offset depends on the instant).
  let utc = naive - offsetMs(new Date(naive), job.tz);
  utc = naive - offsetMs(new Date(utc), job.tz);
  return utc;
}

async function readLastRun(state: string): Promise<number> {
  try {
    const at = Date.parse(JSON.parse(await readFile(state, "utf8"))?.lastRunAt ?? "");
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0;
  }
}

async function writeLastRun(state: string, when: number): Promise<void> {
  try {
    await mkdir(dirname(state), { recursive: true });
    await writeFile(state, `${JSON.stringify({ lastRunAt: new Date(when).toISOString() }, null, 1)}\n`);
  } catch (err) {
    console.error(`[jobs-cron] could not persist state for ${state}`, String(err));
  }
}

async function fire(job: CronJob): Promise<boolean> {
  if (job.fresh) {
    // Fresh session every run: yesterday's transcript is dead weight (tokens) for today's cycle.
    const site = getSite(job.site);
    if (site) await rotateConversation(site.id, pageSlugFor(site, job.page));
  }
  const res = await fetch(`http://127.0.0.1:${PORT}/sites/${job.site}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ak-internal": SECRET },
    body: JSON.stringify({ text: job.prompt, page: job.page }),
  });
  await res.body?.cancel(); // durable job — don't hold the SSE stream open
  if (!res.ok) {
    console.error(`[jobs-cron] enqueue failed for ${job.site}: ${res.status} ${res.statusText}`);
    return false;
  }
  return true;
}

async function tick(job: CronJob): Promise<void> {
  try {
    if (!SECRET) return;
    const now = Date.now();
    if (now - startedAt < BOOT_GRACE_MS) return;

    let dueAt: number;
    let last: number;
    let intervalMs: number | undefined;

    if (job.everyHours === undefined) {
      dueAt = scheduledInstant(job);
      if (now < dueAt) return;                    // today's slot hasn't arrived
      last = await readLastRun(job.state);
      if (last >= dueAt) return;                  // already ran for today's slot
    } else {
      intervalMs = job.everyHours * 3_600_000;
      last = await readLastRun(job.state);
      dueAt = last === 0 ? now : last + intervalMs;
      if (now - last < intervalMs) return;
    }

    // Never stack cycles — but a job wedged "running" must not silence the schedule forever.
    if (listActive(job.site).some((active) => active.status === "running")) {
      const overdueLimit = intervalMs === undefined ? 86_400_000 : 2 * intervalMs;
      if (now - dueAt < overdueLimit) return;
      console.warn(
        intervalMs === undefined
          ? `[jobs-cron] ${job.site} is still running but is a day overdue — firing anyway`
          : `[jobs-cron] ${job.site} is still running but is over two intervals overdue — firing anyway`,
      );
    }

    console.log(
      intervalMs === undefined
        ? `[jobs-cron] firing ${job.site} for the ${String(job.hour).padStart(2, "0")}:00 ${job.tz} slot ` +
          `(${new Date(dueAt).toISOString()}); last run ${last ? new Date(last).toISOString() : "never"}`
        : `[jobs-cron] firing ${job.site} on its ${job.everyHours}h interval; ` +
          `last run ${last ? new Date(last).toISOString() : "never"}`,
    );
    const stampedAt = Date.now();
    await writeLastRun(job.state, stampedAt);      // stamp first so a crash can't retry-loop
    try {
      if (!(await fire(job))) await writeLastRun(job.state, last);
    } catch (err) {
      await writeLastRun(job.state, last);
      throw err;
    }
  } catch (err) {
    console.error(`[jobs-cron] tick error for ${job.site}`, String(err));
  }
}

async function tickAll(jobs: CronJob[]): Promise<void> {
  await Promise.all(jobs.map((job) => tick(job)));
}

export function startJobsCron(): void {
  if (!SECRET) {
    console.warn("[jobs-cron] AK_INTERNAL_SECRET unset — cron disabled");
    return;
  }

  const jobs = loadCronJobs();
  if (jobs.length === 0) {
    console.log("[jobs-cron] no enabled schedules in JOBS_CRONS — cron disabled");
    return;
  }

  for (const job of jobs) {
    if (job.everyHours === undefined) {
      const today = scheduledInstant(job);
      const next = Date.now() < today ? today : scheduledInstant(job, 1);
      console.log(
        `[jobs-cron] armed — site ${job.site}; daily at ${String(job.hour).padStart(2, "0")}:00 ${job.tz}; ` +
        `next slot ${new Date(next).toISOString()}; state at ${job.state}`,
      );
    } else {
      console.log(
        `[jobs-cron] armed — site ${job.site}; every ${job.everyHours} hours; state at ${job.state}`,
      );
    }
  }

  void tickAll(jobs);
  const timer = setInterval(() => void tickAll(jobs), TICK_MS);
  timer.unref?.();
}
