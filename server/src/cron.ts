import { listActive } from "./jobs.js";

const DEFAULT_INTERVAL_MS = 4 * 3_600_000;
const configuredInterval = Number(process.env.JOBS_CRON_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
const INTERVAL_MS = Number.isFinite(configuredInterval) && configuredInterval > 0
  ? configuredInterval
  : DEFAULT_INTERVAL_MS;
const SITE = process.env.JOBS_CRON_SITE ?? "cv-jobs";
const SECRET = process.env.AK_INTERNAL_SECRET ?? "";
const PORT = Number(process.env.PORT ?? 8080);
const PROMPT = "[scheduled] Run one job-hunt cycle: open CLOUD_WORKER.md at the root of this checkout and follow it end to end. Reply with a one-line summary of what happened.";

async function tick(): Promise<void> {
  try {
    if (listActive(SITE).some((job) => job.status === "running")) {
      console.log(`[jobs-cron] tick skipped — job already running for ${SITE}`);
      return;
    }
    const res = await fetch(`http://127.0.0.1:${PORT}/sites/${SITE}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ak-internal": SECRET,
      },
      body: JSON.stringify({ text: PROMPT, page: "/jobs" }),
    });
    if (!res.ok) {
      console.error(`[jobs-cron] message POST failed: ${res.status} ${res.statusText}`);
    }
    await res.body?.cancel();
  } catch (err) {
    console.error("[jobs-cron] tick failed", err);
  }
}

export function startJobsCron(): void {
  if (!SECRET) {
    console.warn("[jobs-cron] AK_INTERNAL_SECRET unset — cron disabled");
    return;
  }
  console.log(`[jobs-cron] starting — every ${INTERVAL_MS}ms for ${SITE}`);
  const timer = setInterval(() => void tick(), INTERVAL_MS);
  timer.unref?.();
}
