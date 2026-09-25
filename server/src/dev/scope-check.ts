// Unit-style check of the per-user scoping in auth.ts: parseAllowedList (the
// allowed-emails.json format — strings for full access, {email, sites,
// pathPrefix?, paths?} for scoped users), allowsSite (the auth-side site gate)
// and pathScopeNote (the per-site path note on every prompt).
// Malformed entries must be skipped: a typo must never widen access.
// Run: `npx tsx src/dev/scope-check.ts` (kept out of the Docker image path).

import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { parseAllowedList, allowsSite, denySite, pathScopeNote, type AuthedUser } from "../auth.js";

// Mixed file: a plain string, a scoped entry, and malformed entries.
const parsed = parseAllowedList(
  JSON.stringify([
    "Owner@Example.com ",
    { email: "Boss@Example.com", sites: ["closeout"], pathPrefix: "report/" },
    { email: "typo@example.com", sites: [] }, // scoped with no sites → grants nothing
    { sites: ["closeout"] }, // no email → skipped
    42, // junk → skipped
  ]),
);
assert.equal(parsed.size, 2, "only well-formed entries survive");
assert.equal(parsed.get("owner@example.com"), null, "string entry → unrestricted, lowercased+trimmed");
assert.deepEqual(parsed.get("boss@example.com"), { sites: ["closeout"], pathPrefix: "report/" });
assert.ok(!parsed.has("typo@example.com"), "empty sites grants nothing");

// Non-array file → nobody extra.
assert.equal(parseAllowedList('{"email":"x@y.z"}').size, 0);

// allowsSite: unscoped users pass everything, scoped users only their sites.
const owner: AuthedUser = { id: "1", email: "owner@example.com" };
const boss: AuthedUser = { id: "2", email: "boss@example.com", scope: { sites: ["closeout"], pathPrefix: "report/" } };
assert.ok(allowsSite(owner, "closeout") && allowsSite(owner, "halo"), "unscoped → all sites");
assert.ok(allowsSite(boss, "closeout"), "scoped → their site");
assert.ok(!allowsSite(boss, "halo"), "scoped → 403 elsewhere");

const fakeResponse = () => {
  const reply: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      reply.status = code;
      return this;
    },
    json(body: unknown) {
      reply.body = body;
      return this;
    },
  } as unknown as Response;
  return { reply, res };
};

const foreign = fakeResponse();
assert.equal(
  denySite({ user: boss } as unknown as Request, foreign.res, "halo"),
  true,
  "scoped foreign site → denied",
);
assert.equal(foreign.reply.status, 403);
assert.deepEqual(foreign.reply.body, { error: "not authorized for this site" });

const unrestricted = fakeResponse();
assert.equal(
  denySite({ user: owner } as unknown as Request, unrestricted.res, "halo"),
  false,
  "unscoped user → allowed",
);
assert.deepEqual(unrestricted.reply, {}, "allowed request leaves the response untouched");

// Per-site paths: only string prefixes for granted sites survive parsing.
const perSite = parseAllowedList(
  JSON.stringify([
    {
      email: "ash@example.com",
      sites: ["closeout-jobs", "closeout"],
      paths: { closeout: "story/", halo: "x/", "closeout-jobs": 7 }, // unlisted site + non-string → dropped
    },
    { email: "arr@example.com", sites: ["closeout"], paths: ["story/"] }, // array → ignored
    { email: "mix@example.com", sites: ["closeout", "halo"], pathPrefix: "report/", paths: { closeout: "story/" } },
  ]),
);
assert.deepEqual(perSite.get("ash@example.com"), {
  sites: ["closeout-jobs", "closeout"],
  pathPrefix: undefined,
  paths: { closeout: "story/" },
});
assert.deepEqual(perSite.get("arr@example.com"), { sites: ["closeout"], pathPrefix: undefined });

const ash: AuthedUser = { id: "3", email: "ash@example.com", scope: perSite.get("ash@example.com")! };
assert.match(pathScopeNote(ash, "closeout"), /only create, modify, or delete files under "story\/"/, "per-site path → note on that site");
assert.equal(pathScopeNote(ash, "closeout-jobs"), "", "per-site path doesn't leak to other sites");
const mix: AuthedUser = { id: "4", email: "mix@example.com", scope: perSite.get("mix@example.com")! };
assert.match(pathScopeNote(mix, "closeout"), /"story\/"/, "per-site path wins over pathPrefix");
assert.match(pathScopeNote(mix, "halo"), /"report\/"/, "other sites fall back to pathPrefix");
assert.match(pathScopeNote(boss, "closeout"), /"report\/"/, "global pathPrefix still applies");
assert.equal(pathScopeNote(owner, "closeout"), "", "unscoped user → no note");

console.log("scope-check: all assertions passed");
