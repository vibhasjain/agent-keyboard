// Dev check for the isolated browser runner: the URL policy, and that every
// /browser-tasks route is behind the primary-owner middleware (a route added
// without it would be an owner-only surface open to provisioned users).
// Run: `npx tsx src/dev/browser-check.ts`.

import assert from "node:assert/strict";
import express from "express";
import type { Request, Response } from "express";
import type { AddressInfo } from "node:net";

process.env.ALLOWED_EMAIL = "owner@example.com,second@example.com";
process.env.TASK_BROWSER_OWNER_EMAIL = "Task.Owner@Example.com  ";
process.env.AK_INTERNAL_SECRET = "internal-secret";
process.env.AK_RELAY_SECRET = "relay-secret";
// Make requireOwner() consider itself configured without reaching a real
// verifier: every request below is header-authenticated or anonymous.
process.env.SUPABASE_URL = "https://supabase.invalid";
process.env.SUPABASE_ANON_KEY = "anon";

const { browserTasksRouter, requirePrimaryOwner, validUrl } = await import("../browser.js");

for (const ok of [
  "https://example.com",
  "http://example.com/path?q=1#frag",
  "https://sub.example.co.uk:8443/x",
  "  https://example.com/padded  ",
]) {
  assert.ok(validUrl(ok), `should accept ${ok}`);
}

for (const bad of [
  "file:///etc/passwd",
  "data:text/html,<h1>x</h1>",
  "javascript:alert(1)",
  "chrome://settings",
  "about:blank",
  "ftp://example.com/f",
  "ws://example.com",
  "/relative/path",
  "example.com",
  "",
  "   ",
  undefined,
  null,
  42,
  { url: "https://example.com" },
]) {
  assert.equal(validUrl(bad as unknown), null, `should reject ${JSON.stringify(bad)}`);
}

// A valid URL comes back normalized, not echoed.
assert.equal(validUrl("https://example.com"), "https://example.com/");

interface Layer { route?: { path: string; stack: { name: string }[] } }
const routes = (browserTasksRouter().stack as unknown as Layer[])
  .filter((l) => l.route)
  .map((l) => ({ path: l.route!.path, guards: l.route!.stack.map((h) => h.name) }));

assert.deepEqual(
  [...new Set(routes.map((r) => r.path))].sort(),
  [
    "/browser-tasks",
    "/browser-tasks/:taskId",
    "/browser-tasks/:taskId/close",
    "/browser-tasks/:taskId/navigate",
    "/browser-tasks/:taskId/screenshot",
    "/browser-tasks/:taskId/text",
  ],
  `unexpected route set: ${JSON.stringify(routes.map((r) => r.path))}`,
);

for (const route of routes) {
  assert.ok(route.guards.includes("narrow"), `${route.path} is missing the primary-owner guard`);
}

// ─── who the guard lets through ──────────────────────────────────────────────
// The narrow half of requirePrimaryOwner(), driven directly: requireOwner has
// already run and stamped req.user by this point.
const narrow = requirePrimaryOwner()[1]!;

function verdict(email: string | undefined, env: Record<string, string | undefined> = {}): number | "next" {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  let status: number | "next" = 0;
  const req = { user: email === undefined ? undefined : { id: "u", email } } as unknown as Request;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  narrow(req, res, () => {
    status = "next";
  });
  process.env = saved;
  return status;
}

// TASK_BROWSER_OWNER_EMAIL wins, trimmed and case-insensitive on both sides.
assert.equal(verdict("task.owner@example.com"), "next");
assert.equal(verdict("TASK.OWNER@EXAMPLE.COM"), "next");
// …and it displaces ALLOWED_EMAIL entirely: the first ALLOWED_EMAIL address is
// NOT the browser owner while the override names someone else.
assert.equal(verdict("owner@example.com"), 403);
assert.equal(verdict("second@example.com"), 403);
assert.equal(verdict("provisioned.guest@example.com"), 403); // allowed-emails.json identity
assert.equal(verdict("cron@internal"), 403);
assert.equal(verdict("relay@internal"), 403);
assert.equal(verdict(undefined), 403);

// Unset the override and the first NON-EMPTY ALLOWED_EMAIL entry takes over.
const noOverride = { TASK_BROWSER_OWNER_EMAIL: undefined };
assert.equal(verdict("owner@example.com", noOverride), "next");
assert.equal(verdict("second@example.com", noOverride), 403);
assert.equal(verdict("owner@example.com", { ...noOverride, ALLOWED_EMAIL: " , ,Owner@Example.com ,second@x" }), "next");

// Neither configured: fail closed, nobody passes.
assert.equal(verdict("owner@example.com", { TASK_BROWSER_OWNER_EMAIL: undefined, ALLOWED_EMAIL: undefined }), 500);
assert.equal(verdict("owner@example.com", { TASK_BROWSER_OWNER_EMAIL: "   ", ALLOWED_EMAIL: " , " }), 500);

// ─── the same guard over real HTTP ───────────────────────────────────────────
// Machine identities requireOwner() accepts (x-ak-internal on loopback,
// x-ak-relay) must still be refused here, before anything launches.
const app = express();
app.use(browserTasksRouter());
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function post(headers: Record<string, string>): Promise<number> {
  const res = await fetch(`${base}/browser-tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ url: "https://example.com" }),
  });
  await res.body?.cancel();
  return res.status;
}

assert.equal(await post({}), 401, "anonymous must not reach the runner");
assert.equal(await post({ "x-ak-internal": "internal-secret" }), 403, "cron/internal must not drive a browser");
assert.equal(await post({ "x-ak-relay": "relay-secret" }), 403, "a relayed agent must not drive a browser");
assert.equal(await post({ "x-ak-internal": "wrong" }), 401, "a bad internal secret is not a login");
server.close();

console.log(`browser-check OK (${routes.length} routes guarded; override, fallback, fail-closed and machine identities covered)`);
