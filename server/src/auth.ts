// Supabase session verification. The widget sends the user's Supabase access
// token as a Bearer; we verify it by asking Supabase who it belongs to, then
// require it to be on the allow-list (the agent has write access to real repos,
// so the gate is deliberately strict: allow-listed accounts only, no public
// signups, no multi-tenancy).
// Read-only viewers may instead use a Google ID token from a configured client:
// hypertrack.io Workspace accounts (optionally site-scoped), env allow-listed
// personal accounts, or runtime-provisioned accounts (with their saved scope).
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
import { createHmac, createPublicKey, createVerify, timingSafeEqual, type JsonWebKey } from "node:crypto";
import { readDataFile } from "./checkouts.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const AK_INTERNAL_SECRET = process.env.AK_INTERNAL_SECRET ?? "";
const SESSION_SECRET = process.env.SESSION_SECRET ?? "";
const GOOGLE_HD = "hypertrack.io";
const GOOGLE_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
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
const GOOGLE_CLIENT_IDS = csv(process.env.GOOGLE_OAUTH_CLIENT_ID);
const GOOGLE_HD_SITES = csv(process.env.GOOGLE_HD_SITES);

// A provisioned entry may carry a scope: which site ids the user may operate
// on, and (optionally) a repo path prefix their change requests are confined
// to. Env-listed owners (ALLOWED_EMAIL) are never scoped. `null` scope = full
// access (a plain string entry).
export interface UserScope {
  sites: string[];
  pathPrefix?: string;
}

/** Parse allowed-emails.json content: entries are "email" strings (full access)
 *  or {email, sites, pathPrefix?} objects (scoped). Malformed entries are
 *  skipped — a typo must never widen access. Exported for the dev check. */
export function parseAllowedList(raw: string): Map<string, UserScope | null> {
  const out = new Map<string, UserScope | null>();
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return out;
  for (const entry of parsed) {
    if (typeof entry === "string") {
      out.set(entry.toLowerCase().trim(), null);
    } else if (entry && typeof entry === "object" && typeof entry.email === "string") {
      const sites = Array.isArray(entry.sites) ? entry.sites.map(String).filter(Boolean) : [];
      if (!sites.length) continue; // a scoped entry with no sites grants nothing
      const pathPrefix = typeof entry.pathPrefix === "string" && entry.pathPrefix ? entry.pathPrefix : undefined;
      out.set(entry.email.toLowerCase().trim(), { sites, pathPrefix });
    }
  }
  return out;
}

// Runtime-provisioned emails (allowed-emails.json on the volume), cached
// briefly so the auth hot path doesn't stat the disk per request.
const LIST_TTL_MS = 10_000;
let listCache: { entries: Map<string, UserScope | null>; at: number } = { entries: new Map(), at: 0 };
async function provisionedEntries(): Promise<Map<string, UserScope | null>> {
  const now = Date.now();
  if (now - listCache.at < LIST_TTL_MS) return listCache.entries;
  let entries = new Map<string, UserScope | null>();
  try {
    const raw = await readDataFile("agent-keyboard/allowed-emails.json");
    if (raw) entries = parseAllowedList(raw);
  } catch {
    /* unreadable list = nobody extra */
  }
  listCache = { entries, at: now };
  return entries;
}

/** Allowed → the user's scope (null = unrestricted); not allowed → undefined. */
async function allowedScope(email: string): Promise<UserScope | null | undefined> {
  const e = email.toLowerCase();
  if (ALLOWED_EMAILS.has(e)) return null;
  const entries = await provisionedEntries();
  return entries.has(e) ? entries.get(e) : undefined;
}

/** True when this user may operate on the given site (unscoped users always may). */
export function allowsSite(user: AuthedUser, siteId: string): boolean {
  return !user.scope || user.scope.sites.includes(siteId);
}

/** 403 + true when the caller is a scoped user and this site isn't theirs. */
export function denySite(req: Request, res: Response, siteId: string): boolean {
  const user = (req as Request & { user?: AuthedUser }).user;
  if (user && !allowsSite(user, siteId)) {
    res.status(403).json({ error: "not authorized for this site" });
    return true;
  }
  return false;
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
  // Present for verified Workspace viewers; personal Google viewers omit it.
  hd?: string;
  // Present for scoped provisioned users or site-confined Workspace viewers.
  scope?: UserScope;
}

interface CacheEntry {
  user: AuthedUser | null; // null = a verified-invalid token (also cached, briefly)
  at: number;
}
interface GoogleCacheEntry extends CacheEntry {
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();
const googleCache = new Map<string, GoogleCacheEntry>();

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_JWKS_DEFAULT_TTL_MS = 60 * 60_000;
const GOOGLE_JWKS_REFETCH_MS = 60_000;
let googleKeys = new Map<string, JsonWebKey>();
let googleKeysExpiresAt = 0;
let googleKeysFetchedAt = 0;
let googleKeysFetch: Promise<void> | null = null;

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
      const scope = body?.email ? await allowedScope(body.email) : undefined;
      const idOk = ALLOWED_USER_IDS.size === 0 || (!!body?.id && ALLOWED_USER_IDS.has(body.id.toLowerCase()));
      if (scope !== undefined && idOk && body.id && body.email) {
        user = { id: body.id, email: body.email, ...(scope ? { scope } : {}) };
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

async function refreshGoogleKeys(): Promise<void> {
  if (googleKeysFetch) return googleKeysFetch;
  const now = Date.now();
  if (now - googleKeysFetchedAt < GOOGLE_JWKS_REFETCH_MS) return;
  googleKeysFetchedAt = now;
  googleKeysFetch = (async () => {
    const res = await fetch(GOOGLE_JWKS_URL);
    if (!res.ok) throw new Error(`Google JWKS returned ${res.status}`);
    const body = (await res.json()) as { keys?: JsonWebKey[] };
    const keys = new Map<string, JsonWebKey>();
    for (const key of body.keys ?? []) {
      if (typeof key.kid === "string") keys.set(key.kid, key);
    }
    const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/i.exec(res.headers.get("cache-control") ?? "");
    const ttl = maxAge ? Number(maxAge[1]) * 1000 : GOOGLE_JWKS_DEFAULT_TTL_MS;
    googleKeys = keys;
    googleKeysExpiresAt = Date.now() + ttl;
  })();
  try {
    await googleKeysFetch;
  } finally {
    googleKeysFetch = null;
  }
}

async function googleKey(kid: string): Promise<JsonWebKey | null> {
  if (Date.now() >= googleKeysExpiresAt) {
    await refreshGoogleKeys();
    if (Date.now() >= googleKeysExpiresAt) return null;
  }
  let key = googleKeys.get(kid);
  if (!key) {
    await refreshGoogleKeys();
    key = googleKeys.get(kid);
  }
  return key ?? null;
}

export async function verifyGoogle(token: string): Promise<AuthedUser | null> {
  if (!GOOGLE_CLIENT_IDS.size || !JWT_RE.test(token)) return null;
  const now = Date.now();
  const hit = googleCache.get(token);
  if (hit && now - hit.at < CACHE_TTL_MS && now < hit.expiresAt) return hit.user;

  try {
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    if (!encodedHeader || !encodedPayload || !encodedSignature) return null;
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
    const jwk = await googleKey(header.kid);
    if (!jwk) return null;
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    verifier.end();
    if (!verifier.verify(createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(encodedSignature, "base64url"))) {
      return null;
    }

    const nowSeconds = Math.floor(now / 1000);
    const issuerOk = payload.iss === "https://accounts.google.com" || payload.iss === "accounts.google.com";
    const issuedAtOk = payload.iat === undefined ||
      (typeof payload.iat === "number" && payload.iat <= nowSeconds + 300);
    const claimsOk = issuerOk && typeof payload.aud === "string" &&
      GOOGLE_CLIENT_IDS.has(payload.aud) &&
      typeof payload.exp === "number" && payload.exp > nowSeconds && issuedAtOk &&
      payload.email_verified === true && typeof payload.email === "string" &&
      typeof payload.sub === "string";
    let user: AuthedUser | null = null;
    if (claimsOk) {
      const id = String(payload.sub);
      const email = String(payload.email);
      if (payload.hd === GOOGLE_HD) {
        const scope = GOOGLE_HD_SITES.size ? { sites: [...GOOGLE_HD_SITES] } : undefined;
        user = { id, email, hd: GOOGLE_HD, ...(scope ? { scope } : {}) };
      } else if (payload.hd === undefined) {
        // Personal Google accounts have no hosted-domain claim. A foreign
        // hosted domain must not inherit access merely because its email is on
        // an allow-list.
        const scope = await allowedScope(email);
        if (scope !== undefined) user = { id, email, ...(scope ? { scope } : {}) };
      }
    }
    if (googleCache.size >= CACHE_MAX) {
      const oldest = googleCache.keys().next().value;
      if (oldest !== undefined) googleCache.delete(oldest);
    }
    const expiresAt = user && typeof payload.exp === "number"
      ? payload.exp * 1000
      : now + CACHE_TTL_MS;
    googleCache.set(token, { user, at: now, expiresAt });
    return user;
  } catch {
    return null;
  }
}

interface GoogleSessionPayload {
  email: string;
  hd: string | null;
  iat: number;
  exp: number;
}

function encodeSessionPart(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sessionSignature(message: string): Buffer {
  return createHmac("sha256", SESSION_SECRET).update(message).digest();
}

export function googleSessionsConfigured(): boolean {
  return !!SESSION_SECRET;
}

/** Mint a 30-day viewer session after a Google ID token is verified. */
export function mintGoogleSession(
  user: AuthedUser,
  nowSeconds = Math.floor(Date.now() / 1000),
): { sessionToken: string; exp: number } {
  if (!SESSION_SECRET) throw new Error("SESSION_SECRET unset");
  const exp = nowSeconds + GOOGLE_SESSION_TTL_SECONDS;
  const header = encodeSessionPart({ alg: "HS256", typ: "JWT" });
  const payload = encodeSessionPart({ email: user.email, hd: user.hd ?? null, iat: nowSeconds, exp });
  const message = `${header}.${payload}`;
  return {
    sessionToken: `${message}.${sessionSignature(message).toString("base64url")}`,
    exp,
  };
}

/** Verify a server-minted Google viewer session and refresh its current scope. */
export async function verifyGoogleSession(token: string): Promise<AuthedUser | null> {
  if (!SESSION_SECRET || !JWT_RE.test(token)) return null;
  try {
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    if (!encodedHeader || !encodedPayload || !encodedSignature) return null;
    const message = `${encodedHeader}.${encodedPayload}`;
    const got = Buffer.from(encodedSignature, "base64url");
    const expected = sessionSignature(message);
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;

    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<GoogleSessionPayload>;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (header.alg !== "HS256" || header.typ !== "JWT" ||
        typeof payload.email !== "string" || !payload.email ||
        !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) ||
        (payload.iat as number) > nowSeconds + 300 || (payload.exp as number) <= nowSeconds ||
        (payload.exp as number) <= (payload.iat as number)) {
      return null;
    }
    if (payload.hd === GOOGLE_HD) {
      const scope = GOOGLE_HD_SITES.size ? { sites: [...GOOGLE_HD_SITES] } : undefined;
      return {
        id: payload.email,
        email: payload.email,
        hd: GOOGLE_HD,
        ...(scope ? { scope } : {}),
      };
    }
    if (payload.hd !== null) return null;
    const scope = await allowedScope(payload.email);
    if (scope === undefined) return null;
    return { id: payload.email, email: payload.email, ...(scope ? { scope } : {}) };
  } catch {
    return null;
  }
}

interface OwnerAuth {
  user: AuthedUser | null;
  token: string;
  configured: boolean;
}

async function authenticateOwner(req: Request): Promise<OwnerAuth> {
  if (AK_INTERNAL_SECRET && isInternalSecret(req.header("x-ak-internal") ?? "")) {
    if (isLoopback(req)) {
      return {
        user: { id: "internal", email: "cron@internal" },
        token: "",
        configured: true,
      };
    }
    console.warn(
      `[auth] x-ak-internal presented from non-loopback peer ${req.ip ?? req.socket.remoteAddress ?? "unknown"} — ignoring`,
    );
  }
  const token = bearer(req);
  const configured = !!SUPABASE_URL && !!SUPABASE_ANON_KEY;
  return {
    user: configured && token ? await verify(token) : null,
    token,
    configured,
  };
}

function allow(req: Request, user: AuthedUser, next: NextFunction): void {
  (req as Request & { user?: AuthedUser }).user = user;
  next();
}

/** Express middleware: 401 without a token, 403 for a valid-but-wrong identity. */
export function requireOwner() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const owner = await authenticateOwner(req);
    if (owner.user) {
      allow(req, owner.user, next);
      return;
    }
    if (!owner.configured) {
      res.status(500).json({ error: "server not configured: SUPABASE_URL / SUPABASE_ANON_KEY unset" });
      return;
    }
    if (!owner.token) {
      res.status(401).json({ error: "sign in required" });
      return;
    }
    // We can't cheaply distinguish "invalid token" (401) from "valid but not
    // the owner" (403) without a second lookup; a wrong/expired token is by
    // far the common case, so answer 401 and keep it simple.
    res.status(401).json({ error: "invalid session or not authorized" });
  };
}

/** Owner auth plus verified Google access for read-only site routes. */
export function requireOwnerOrGoogle() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = bearer(req);
    if ((req.header("X-Auth-Kind") ?? "").trim().toLowerCase() === "google") {
      if (!token) {
        res.status(401).json({ error: "sign in required" });
        return;
      }
      const user = (await verifyGoogleSession(token)) ?? await verifyGoogle(token);
      if (user) {
        allow(req, user, next);
        return;
      }
      res.status(401).json({ error: "invalid session or not authorized" });
      return;
    }

    const owner = await authenticateOwner(req);
    if (owner.user) {
      allow(req, owner.user, next);
      return;
    }
    if (!token) {
      res.status(401).json({ error: "sign in required" });
      return;
    }
    const user = (await verifyGoogleSession(token)) ?? await verifyGoogle(token);
    if (!user) {
      res.status(401).json({ error: "invalid session or not authorized" });
      return;
    }
    allow(req, user, next);
  };
}
