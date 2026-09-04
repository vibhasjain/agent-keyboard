// Guest fence check: personal env stripped + deny rules generated for guest sites only.
// Run: `npm run guest-check`
import assert from "node:assert/strict";

process.env.SITES = JSON.stringify([
  { id: "mine", repo: "https://github.com/x/mine.git", branch: "main", domain: "mine.test" },
  { id: "shared", repo: "https://github.com/x/shared.git", branch: "main", domain: "shared.test", guest: true },
]);
process.env.GMAIL_APP_PASSWORD = "hunter2";
process.env.GH_TOKEN = "keep-me";

const { SITES } = await import("../sites.js");
const { checkoutPath } = await import("../checkouts.js");
const { spawnEnv, guestArgs, PERSONAL_ENV, cdpPortFor } = await import("../claude.js");
const [mine, shared] = SITES;
assert.ok(mine && shared && shared.guest === true && mine.guest === undefined, "guest flag parses");

const own = spawnEnv(mine, { CLAUDE_X: "1" });
assert.equal(own.GMAIL_APP_PASSWORD, "hunter2");
assert.equal(own.CLAUDE_X, "1");
assert.equal(own.AK_CDP_PORT, "9300");
const guest = spawnEnv(shared, { CLAUDE_X: "1" });
for (const k of PERSONAL_ENV) assert.equal(guest[k], undefined, `${k} must be stripped`);
assert.equal(guest.GH_TOKEN, "keep-me");
assert.equal(guest.CLAUDE_X, "1");
assert.equal(guest.AK_CDP_PORT, "9301");
assert.equal(cdpPortFor("mine"), 9300);
assert.equal(cdpPortFor("shared"), 9301);

assert.deepEqual(guestArgs(mine), []);
const args = guestArgs(shared);
assert.equal(args[0], "--settings");
const deny: string[] = JSON.parse(args[1] ?? "{}").permissions.deny;
assert.ok(deny.includes("Skill(google-calendar)"));
assert.ok(deny.some((r) => r.startsWith("Read(/") && r.endsWith("/allowed-emails.json)")));
assert.ok(deny.includes(`Read(${checkoutPath("mine")}/**)`));
assert.ok(deny.some((r) => r.startsWith("Write(/") && r.endsWith("/sites/mine/**)")));
assert.ok(!deny.some((r) => r.includes("/shared")), "a guest site must not be denied its own files");
console.log(`guest-check OK — ${PERSONAL_ENV.length} personal vars stripped, ${deny.length} deny rules; sample: ${deny.slice(0, 3).join("  ")}`);
