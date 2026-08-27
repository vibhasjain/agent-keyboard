// Unit-style check of JOBS_CRONS parsing, defaults, and legacy fallback.
// Run: `npx tsx src/dev/cron-check.ts` (kept out of the Docker image path).

import assert from "node:assert/strict";

import { loadCronJobs } from "../cron.js";

for (const name of ["JOBS_CRONS", "JOBS_CRON_SITE", "JOBS_CRON_TARGET", "JOBS_CRON_HOUR", "JOBS_CRON_TZ", "JOBS_CRON_STATE"]) {
  delete process.env[name];
}

process.env.JOBS_CRONS = JSON.stringify([
  { site: "alpha", prompt: "Run alpha" },
  { site: "beta-2", prompt: "Run beta", hour: 7, tz: "UTC", everyHours: 2.5, state: "/tmp/beta-cron.json", page: "/tasks", fresh: true },
  { site: "off", prompt: "Do not run", disabled: true },
]);
const configured = loadCronJobs();
assert.equal(configured.length, 2);
assert.deepEqual(
  configured.map(({ site, prompt, hour, tz, everyHours, state, page, fresh }) => ({ site, prompt, hour, tz, everyHours, state, page, fresh })),
  [
    {
      site: "alpha",
      prompt: "Run alpha",
      hour: 11,
      tz: "America/New_York",
      everyHours: undefined,
      state: "/data/agent-keyboard/cron-alpha.json",
      page: "/",
      fresh: false,
    },
    {
      site: "beta-2",
      prompt: "Run beta",
      hour: 7,
      tz: "UTC",
      everyHours: 2.5,
      state: "/tmp/beta-cron.json",
      page: "/tasks",
      fresh: true,
    },
  ],
  "configured jobs should parse, default, and skip disabled entries",
);

process.env.JOBS_CRONS = JSON.stringify([{ site: "bad slug", prompt: "Run" }]);
const originalError = console.error;
console.error = () => undefined;
const invalidFallback = loadCronJobs();
console.error = originalError;
assert.equal(invalidFallback.length, 1);
assert.equal(invalidFallback[0]?.site, "cv-jobs");
assert.equal(invalidFallback[0]?.hour, 11);
assert.equal(invalidFallback[0]?.tz, "America/New_York");
assert.equal(invalidFallback[0]?.state, "/data/agent-keyboard/jobs-cron.json");

delete process.env.JOBS_CRONS;
const legacy = loadCronJobs();
assert.equal(legacy.length, 1);
assert.equal(legacy[0]?.site, "cv-jobs");
assert.equal(legacy[0]?.hour, 11);
assert.equal(legacy[0]?.tz, "America/New_York");
assert.equal(legacy[0]?.state, "/data/agent-keyboard/jobs-cron.json");
assert.equal(legacy[0]?.page, "/jobs");

console.log("cron-check OK — configured defaults, invalid fallback, and legacy scheduling all pass.");
