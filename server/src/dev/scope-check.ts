// Unit-style check of the per-user scoping in auth.ts: parseAllowedList (the
// allowed-emails.json format — strings for full access, {email, sites,
// pathPrefix?} for scoped users) and allowsSite (the auth-side site gate).
// Malformed entries must be skipped: a typo must never widen access.
// Run: `npx tsx src/dev/scope-check.ts` (kept out of the Docker image path).

import assert from "node:assert/strict";
import { parseAllowedList, allowsSite, type AuthedUser } from "../auth.js";

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

console.log("scope-check: all assertions passed");
