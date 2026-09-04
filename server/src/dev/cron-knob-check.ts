// Unit-style check of per-site cron knob arrays and env displacement.
// Run: `npx tsx src/dev/cron-knob-check.ts`.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "agent-keyboard-cron-knob-"));
process.env.AGENT_DATA_DIR = root;
process.env.SITES = JSON.stringify([
  { id: "alpha", repo: "https://github.com/example/alpha.git", branch: "main", domain: "alpha.example.com" },
  { id: "beta", repo: "https://github.com/example/beta.git", branch: "main", domain: "beta.example.com" },
]);

const { effectiveJobs, loadCronJobs } = await import("../cron.js");
const { harnessNote, loadHarness } = await import("../harness.js");

async function writeSettings(siteId: string, cron: unknown): Promise<void> {
  const path = join(root, "agent-keyboard", "sites", siteId, "settings.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ cron }, null, 2)}\n`, "utf8");
}

try {
  await writeSettings("alpha", [
    { id: "apply", prompt: "Apply", hour: 6, fresh: true },
    { id: "linkedin", prompt: "Check LinkedIn", hour: 14, fresh: true },
  ]);
  const arrayHarness = await loadHarness("alpha");
  assert.ok(Array.isArray(arrayHarness.settings.cron));
  assert.deepEqual(arrayHarness.settings.cron.map((entry) => entry.id), ["apply", "linkedin"]);
  const arrayJobs = await effectiveJobs([]);
  assert.deepEqual(
    arrayJobs.map(({ id, state }) => ({ id, state })),
    [
      { id: "apply", state: join(root, "agent-keyboard", "cron-alpha-apply.json") },
      { id: "linkedin", state: join(root, "agent-keyboard", "cron-alpha-linkedin.json") },
    ],
  );
  const note = harnessNote("alpha", arrayHarness, null);
  assert.match(note, /cron apply@06 ET fresh · linkedin@14 ET fresh/);
  assert.match(note, /array form for phases.*unique slug "id"/);

  await writeSettings("alpha", { prompt: "Legacy", hour: 8 });
  const loneJobs = await effectiveJobs([]);
  assert.equal(loneJobs.length, 1);
  assert.equal(loneJobs[0]?.id, "cron");
  assert.equal(loneJobs[0]?.state, join(root, "agent-keyboard", "cron-alpha.json"));

  await writeSettings("alpha", [
    { id: "same", prompt: "First" },
    { id: "same", prompt: "Second" },
  ]);
  const duplicate = await loadHarness("alpha");
  assert.equal(duplicate.settings.cron, undefined);
  assert.equal(duplicate.warnings.length, 1);
  assert.match(duplicate.warnings[0] ?? "", /duplicate id "same"/);

  await writeSettings("alpha", [{ id: "paused", prompt: "Paused", disabled: true }]);
  process.env.JOBS_CRONS = JSON.stringify([
    { site: "alpha", prompt: "Env alpha" },
    { site: "beta", prompt: "Env beta" },
  ]);
  const displaced = await effectiveJobs(loadCronJobs());
  assert.deepEqual(displaced.map((job) => job.site), ["beta"]);

  console.log("cron-knob-check OK — arrays, state paths, duplicate rejection, and disabled displacement pass.");
} finally {
  await rm(root, { recursive: true, force: true });
}
