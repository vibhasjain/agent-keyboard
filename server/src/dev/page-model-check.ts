// Unit-style check of the per-page model/effort override (harness "pages" knob).
// Run: `npx tsx src/dev/page-model-check.ts`.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "agent-keyboard-page-model-"));
process.env.AGENT_DATA_DIR = root;
process.env.SITES = JSON.stringify([
  { id: "alpha", repo: "https://github.com/example/alpha.git", branch: "main", domain: "alpha.example.com", sessionScope: "page" },
]);

const { harnessNote, loadHarness } = await import("../harness.js");
const { getSite, pageSlugFor } = await import("../sites.js");

async function writeSettings(settings: unknown): Promise<void> {
  const path = join(root, "agent-keyboard", "sites", "alpha", "settings.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

const site = getSite("alpha")!;

await writeSettings({
  model: "claude-fable-5-1",
  effort: "high",
  pages: { "/jobs": { model: "opus" }, "/quiet": { effort: "low" } },
});

// The site root keeps the site-wide values.
const root_ = await loadHarness("alpha", pageSlugFor(site, "/"));
assert.equal(root_.settings.model, "claude-fable-5-1");
assert.ok(root_.args.includes("claude-fable-5-1"));

// The overridden page runs its own model, and keeps the site effort.
const jobs = await loadHarness("alpha", pageSlugFor(site, "/jobs"));
assert.equal(jobs.settings.model, "opus");
assert.equal(jobs.settings.effort, "high");
assert.deepEqual(jobs.args.slice(jobs.args.indexOf("--model"), jobs.args.indexOf("--model") + 2), ["--model", "opus"]);

// Key spellings normalize to the same slug the request produces.
assert.equal((await loadHarness("alpha", pageSlugFor(site, "/jobs/"))).settings.model, "opus");
assert.equal((await loadHarness("alpha", pageSlugFor(site, "/jobs?tab=1"))).settings.model, "opus");

// effort-only override leaves the model alone.
const quiet = await loadHarness("alpha", pageSlugFor(site, "/quiet"));
assert.equal(quiet.settings.model, "claude-fable-5-1");
assert.equal(quiet.settings.effort, "low");

// An un-overridden page is untouched.
assert.equal((await loadHarness("alpha", pageSlugFor(site, "/other"))).settings.model, "claude-fable-5-1");

// A page override is validated exactly like the site knob: a bad model is
// warned about and dropped, leaving the site value in force.
await writeSettings({ model: "opus", pages: { "/jobs": { model: "gpt-4", speed: "fast" } } });
const bad = await loadHarness("alpha", pageSlugFor(site, "/jobs"));
assert.equal(bad.settings.model, "opus");
assert.ok(bad.warnings.some((w) => w.includes("unknown model")), bad.warnings.join(" | "));
assert.ok(bad.warnings.some((w) => w.includes("not overridable")), bad.warnings.join(" | "));

// A non-object pages block is ignored with a warning, never a crash.
await writeSettings({ model: "opus", pages: ["/jobs"] });
const wrong = await loadHarness("alpha", "jobs");
assert.equal(wrong.settings.model, "opus");
assert.ok(wrong.warnings.some((w) => w.includes("pages must be an object")));

// The knob is documented to the agent so it can self-configure.
assert.ok(harnessNote("alpha", jobs, null).includes('"pages"'));

console.log("page-model-check OK");
