// Mint → use → revoke round-trip for long-lived agent keys (auth.ts).
// Run: AGENT_DATA_DIR=$(mktemp -d) ALLOWED_EMAIL=o@x.com SUPABASE_URL=http://x SUPABASE_ANON_KEY=x node --import tsx src/dev/agent-key-check.ts
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { listAgentKeys, mintAgentKey, requireOwner, revokeAgentKey, type AuthedUser } from "../auth.js";

async function call(token: string): Promise<{ status: number; user?: AuthedUser }> {
  const req = { header: (h: string) => (h.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined), ip: "1.2.3.4", socket: {} } as unknown as Request;
  let status = 200;
  const res = { status(s: number) { status = s; return this; }, json() { return this; }, setHeader() {} } as unknown as Response;
  await requireOwner()(req, res, (() => {}) as NextFunction);
  return { status, user: (req as Request & { user?: AuthedUser }).user };
}

const owner: AuthedUser = { id: "u1", email: "o@x.com" };
const { key, record } = await mintAgentKey(owner, "nutrition");
const b = await mintAgentKey(owner, "pixels");
assert.ok(key.startsWith("akk_"));
assert.ok(!(await listAgentKeys()).some((k) => JSON.stringify(k).includes(key)), "raw key never stored");
const ok = await call(key);
assert.equal(ok.user?.email, "o@x.com");
assert.equal(ok.user?.agentKey, "nutrition");
assert.equal((await call("akk_bogus")).status, 401);
assert.equal(await revokeAgentKey({ id: "u2", email: "other@x.com" }, record.id), false, "others can't revoke");
assert.equal(await revokeAgentKey(owner, record.id), true);
assert.equal((await call(key)).status, 401, "revoked key dies");
assert.equal((await call(b.key)).user?.agentKey, "pixels", "other key unaffected");
console.log("agent-key-check OK");
