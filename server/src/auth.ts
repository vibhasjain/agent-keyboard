// Supabase session verification. The widget sends the user's Supabase access
// token as a Bearer; we verify it by asking Supabase who it belongs to, then
// require it to be on the allow-list (the agent has write access to real repos,
// so the gate is deliberately strict: allow-listed accounts only, no public
// signups, no multi-tenancy).
//
// The allowed identities come from env: ALLOWED_EMAIL — one email, or a
// comma-separated few (a client, a partner) — matched case-insensitively, and
// an optional ALLOWED_USER_ID pin (one or more Supabase UUIDs, checked only if
// set). A 60s in-memory cache keeps us from hitting Supabase on every SSE
// re-attach / poll.
//
// Emails provisioned at runtime (the provision-user skill: "invite
// esther@example.com") land in /data/agent-keyboard/allowed-emails.json — the
// gate accepts the union of the env list and that file. NOTE: if
// ALLOWED_USER_ID is set, it still pins auth to those ids and provisioned
// users are rejected — unset it to use runtime provisioning.

import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { readDataFile } from "./checkouts.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const AK_INTERNAL_SECRET = process.env.AK_INTERNAL_SECRET ?? "";
function isInternalSecret(got: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(AK_INTERNAL_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}
// `trust proxy` is never enabled (see index.ts), so req.ip is the real socket
// peer and cannot be spoofed via X-Forwarded-For. Undefined/empty fails closed.
function isLoopback(req: Request): boolean {
  const ip = req.ip ?? req.socket.remoteAddress ?? "";
  return ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.");
}
const csv = (v: string | undefined): Set<string> =>
  new Set(
    (v ?? "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
const ALLOWED_EMAILS = csv(process.env.ALLOWED_EMAIL);
const ALLOWED_USER_IDS = csv(process.env.ALLOWED_USER_ID);

// Runtime-provisioned emails (allowed-emails.json on the volume), cached
// briefly so the auth hot path doesn't stat the disk per request.
const LIST_TTL_MS = 10_000;
let listCache: { emails: Set<string>; at: number } = { emails: new Set(), at: 0 };
async function provisionedEmails(): Promise<Set<string>> {
  const now = Date.now();
  if (now - listCache.at < LIST_TTL_MS) return listCache.emails;
  const emails = new Set<string>();
  try {
    const raw = await readDataFile("agent-keyboard/allowed-emails.json");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) for (const e of parsed) emails.add(String(e).toLowerCase().trim());
    }
  } catch {
    /* unreadable list = nobody extra */
  }
  listCache = { emails, at: now };
  return emails;
}

async function isAllowedEmail(email: string): Promise<boolean> {
  const e = email.toLowerCase();
  if (ALLOWED_EMAILS.has(e)) return true;
  return (await provisionedEmails()).has(e);
}

const CACHE_TTL_MS = 60_000;
// Cap the verification cache so a flood of unique tokens from an unauthenticated
// caller can't grow it without bound; once full, entries evict FIFO (the Map
// preserves insertion order). A no-token request never reaches here — it's a
// bare 401 in requireOwner — so this only bounds token-bearing traffic.
const CACHE_MAX = 500;
// A Supabase access token is a JWT: three non-empty base64url segments. Anything
// else is rejected locally, without spending an outbound /auth/v1/user call — so
// a garbage token is as cheap to reject as no token at all.
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface AuthedUser {
  id: string;
  email: string;
}

interface CacheEntry {
  user: AuthedUser | null; // null = a verified-invalid token (also cached, briefly)
  at: number;
}
const cache = new Map<string, CacheEntry>();

function bearer(req: Request): string {
  const h = req.header("Authorization") ?? "";
  return h.replace(/^Bearer\s+/i, "").trim();
}

/** Verify a Supabase token → the allowed owner, or null. Cached 60s per token. */
async function verify(token: string): Promise<AuthedUser | null> {
  if (!JWT_RE.test(token)) return null; // not a JWT — reject before any I/O or caching
  const now = Date.now();
  const hit = cache.get(token);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.user;

  let user: AuthedUser | null = null;
  try {
    const res = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
    });
    if (res.ok) {
      const body = (await res.json()) as { id?: string; email?: string };
      const emailOk = !!body?.email && (await isAllowedEmail(body.email));
      const idOk = ALLOWED_USER_IDS.size === 0 || (!!body?.id && ALLOWED_USER_IDS.has(body.id.toLowerCase()));
      if (emailOk && idOk && body.id && body.email) {
        user = { id: body.id, email: body.email };
      }
    }
  } catch {
    // Network / Supabase down: treat as unauthenticated, but don't cache the
    // failure (so a transient blip doesn't lock the owner out for 60s).
    return null;
  }
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value; // FIFO evict to bound memory
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(token, { user, at: now });
  return user;
}

/** Express middleware: 401 without a token, 403 for a valid-but-wrong identity. */
export function requireOwner() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (AK_INTERNAL_SECRET && isInternalSecret(req.header("x-ak-internal") ?? "")) {
      if (isLoopback(req)) {
        (req as Request & { user?: AuthedUser }).user = {
          id: "internal",
          email: "cron@internal",
        };
        next();
        return;
      }
      console.warn(
        `[auth] x-ak-internal presented from non-loopback peer ${req.ip ?? req.socket.remoteAddress ?? "unknown"} — ignoring`,
      );
    }
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      res.status(500).json({ error: "server not configured: SUPABASE_URL / SUPABASE_ANON_KEY unset" });
      return;
    }
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: "sign in required" });
      return;
    }
    const user = await verify(token);
    if (!user) {
      // We can't cheaply distinguish "invalid token" (401) from "valid but not
      // the owner" (403) without a second lookup; a wrong/expired token is by
      // far the common case, so answer 401 and keep it simple.
      res.status(401).json({ error: "invalid session or not authorized" });
      return;
    }
    (req as Request & { user?: AuthedUser }).user = user;
    next();
  };
}
