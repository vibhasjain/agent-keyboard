// Supabase session verification. The widget sends the owner's Supabase access
// token as a Bearer; we verify it by asking Supabase who it belongs to, then
// require it to be THE single allowed user (this is a single-user product — the
// agent has write access to real repos, so the gate is deliberately strict).
//
// The allowed identity comes from env: ALLOWED_EMAIL (required, matched
// case-insensitively) and an optional ALLOWED_USER_ID (Supabase UUID, checked
// only if set). A 60s in-memory cache keeps us from hitting Supabase on every
// SSE re-attach / poll.

import type { Request, Response, NextFunction } from "express";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const ALLOWED_EMAIL = (process.env.ALLOWED_EMAIL ?? "").toLowerCase().trim();
const ALLOWED_USER_ID = (process.env.ALLOWED_USER_ID ?? "").trim();

const CACHE_TTL_MS = 60_000;

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
      const emailOk = !!body?.email && body.email.toLowerCase() === ALLOWED_EMAIL;
      const idOk = !ALLOWED_USER_ID || body?.id === ALLOWED_USER_ID;
      if (emailOk && idOk && body.id && body.email) {
        user = { id: body.id, email: body.email };
      }
    }
  } catch {
    // Network / Supabase down: treat as unauthenticated, but don't cache the
    // failure (so a transient blip doesn't lock the owner out for 60s).
    return null;
  }
  cache.set(token, { user, at: now });
  return user;
}

/** Express middleware: 401 without a token, 403 for a valid-but-wrong identity. */
export function requireOwner() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
