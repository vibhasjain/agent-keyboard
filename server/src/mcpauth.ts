/**
 * Server-side MCP OAuth sign-in (spec 22). The server runs the OAuth 2.1 flow for
 * an MCP server (RFC 9728 / 8414 discovery, RFC 7591 registration, PKCE) with
 * its own /oauth/callback, keeps the tokens encrypted on the volume, and gives
 * the agent a local proxy (/mcp-proxy/<site>/<name>) that adds the bearer and
 * refreshes it. The agent never sees a token.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Router } from "express";
import { DATA_DIR } from "./checkouts.js";

const SECRET = process.env.AK_INTERNAL_SECRET ?? "";
const PORT = process.env.PORT ?? 8080;
const STATE = join(DATA_DIR, "agent-keyboard");
const FILE = join(STATE, "mcp-oauth.json");
const KEY = createHash("sha256").update("ak-mcp-oauth\0" + SECRET).digest();
export const mcpAuthEnabled = !!SECRET;

type Client = { clientId: string; clientSecret?: string; authMethod?: string };
type Conn = Client & { url: string; resource: string; tokenEndpoint: string; access: string; refresh?: string; expiresAt?: number; expired?: boolean };
type Store = { clients: Record<string, Client>; sites: Record<string, Record<string, Conn>> };

// ─── encrypted store ────────────────────────────────────────────────────────
let store: Store | null = null;
function db(): Store {
  if (store) return store;
  store = { clients: {}, sites: {} };
  if (existsSync(FILE)) {
    try {
      const b = Buffer.from(readFileSync(FILE, "utf8"), "base64");
      const d = createDecipheriv("aes-256-gcm", KEY, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      store = JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"));
    } catch (e) {
      console.error("[mcp-oauth] can't read the token store:", (e as Error).message);
    }
  }
  return store!;
}
function save(): void {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(db())), c.final()]);
  mkdirSync(STATE, { recursive: true });
  writeFileSync(FILE + ".tmp", Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64"), { mode: 0o600 });
  renameSync(FILE + ".tmp", FILE);
}

// ─── discovery + registration ───────────────────────────────────────────────
const b64url = (b: Buffer) => b.toString("base64url");
async function firstJson(urls: (string | undefined)[]): Promise<Record<string, any> | null> {
  for (const u of urls) {
    if (!u) continue;
    const r = await fetch(u, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (r?.ok) {
      const j = await r.json().catch(() => null);
      if (j && typeof j === "object") return j;
    }
  }
  return null;
}
const wellKnown = (u: URL, name: string) => `${u.origin}/.well-known/${name}${u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "")}`;

async function discover(mcpUrl: string) {
  const u = new URL(mcpUrl);
  // An unauthenticated initialize should get a 401 whose WWW-Authenticate names the metadata.
  const probe = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-keyboard", version: "1" } } }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  void probe?.body?.cancel();
  const hinted = /resource_metadata="([^"]+)"/.exec(probe?.headers.get("www-authenticate") ?? "")?.[1];
  const prm = await firstJson([hinted, wellKnown(u, "oauth-protected-resource"), `${u.origin}/.well-known/oauth-protected-resource`]);
  const issuer = new URL(prm?.authorization_servers?.[0] ?? u.origin);
  const as = await firstJson([wellKnown(issuer, "oauth-authorization-server"), wellKnown(issuer, "openid-configuration"), `${issuer.href.replace(/\/$/, "")}/.well-known/openid-configuration`]);
  if (!as?.authorization_endpoint || !as?.token_endpoint) throw new Error(`${u.host} doesn't publish OAuth metadata`);
  return { as, resource: String(prm?.resource ?? mcpUrl), scope: Array.isArray(prm?.scopes_supported) ? prm.scopes_supported.join(" ") : undefined };
}

async function register(as: Record<string, any>, redirect: string, siteId: string): Promise<Client> {
  const key = `${as.issuer ?? as.authorization_endpoint} ${redirect}`;
  const cached = db().clients[key];
  if (cached) return cached;
  if (!as.registration_endpoint) throw new Error("this server doesn't support dynamic client registration: give a client_id (and client_secret) registered with redirect URI " + redirect);
  const r = await fetch(as.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_name: `Agent Keyboard (${siteId})`, redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, any>;
  if (!r.ok || !j.client_id) throw new Error(`client registration failed (${r.status}${j.error ? `: ${j.error}` : ""})`);
  const c: Client = { clientId: j.client_id, clientSecret: j.client_secret, authMethod: j.token_endpoint_auth_method };
  db().clients[key] = c;
  save();
  return c;
}

async function tokenRequest(c: Client, endpoint: string, params: Record<string, string>) {
  const body = new URLSearchParams({ ...params, client_id: c.clientId });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (c.clientSecret) {
    if (c.authMethod === "client_secret_post") body.set("client_secret", c.clientSecret);
    else headers.authorization = "Basic " + Buffer.from(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret)}`).toString("base64");
  }
  const r = await fetch(endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(15_000) });
  const j = (await r.json().catch(() => ({}))) as Record<string, any>;
  if (!r.ok || typeof j.access_token !== "string") throw new Error(`token request failed (${r.status}${j.error ? `: ${j.error}` : ""})`);
  return j as { access_token: string; refresh_token?: string; expires_in?: number };
}

// ─── sign-in ────────────────────────────────────────────────────────────────
type Pending = { siteKey: string; name: string; url: string; resource: string; tokenEndpoint: string; client: Client; verifier: string; redirect: string; back: string; exp: number };
const pending = new Map<string, Pending>();

export const validName = (n: string) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(n);

/** Discover, register and return the authorize URL the owner should open. */
export async function startSignIn(o: { siteKey: string; siteId: string; url: string; name?: string; origin: string; back: string; clientId?: string; clientSecret?: string }) {
  const u = new URL(o.url);
  if (u.protocol !== "https:" && !/^(localhost|127\.)/.test(u.hostname)) throw new Error("the MCP URL must be https");
  const name = o.name || u.hostname.replace(/^(www|mcp|api)\./, "").split(".")[0]!.toLowerCase();
  if (!validName(name)) throw new Error("name must be lowercase letters, digits and dashes");
  const { as, resource, scope } = await discover(u.href);
  const redirect = `${o.origin}/oauth/callback`;
  const client = o.clientId ? { clientId: o.clientId, clientSecret: o.clientSecret } : await register(as, redirect, o.siteId);
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(24));
  for (const [s, p] of pending) if (p.exp < Date.now()) pending.delete(s);
  pending.set(state, { siteKey: o.siteKey, name, url: u.href, resource, tokenEndpoint: as.token_endpoint, client, verifier, redirect, back: o.back, exp: Date.now() + 10 * 60_000 });
  const a = new URL(as.authorization_endpoint);
  const q: Record<string, string | undefined> = {
    response_type: "code", client_id: client.clientId, redirect_uri: redirect, state, resource, scope,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
  };
  for (const [k, v] of Object.entries(q)) if (v) a.searchParams.set(k, v);
  return { name, signInUrl: a.href, redirectUri: redirect };
}

export function listServers(siteKey: string) {
  return Object.entries(db().sites[siteKey] ?? {}).map(([name, c]) => ({ name, url: c.url, expired: !!c.expired }));
}
export function disconnect(siteKey: string, name: string): boolean {
  const s = db().sites[siteKey];
  if (!s?.[name]) return false;
  delete s[name];
  save();
  return true;
}

// ─── tokens + proxy ─────────────────────────────────────────────────────────
const refreshing = new Map<string, Promise<string | null>>();
async function accessToken(siteKey: string, name: string, force = false): Promise<string | null> {
  const c = db().sites[siteKey]?.[name];
  if (!c) return null;
  if (!force && !c.expired && (!c.expiresAt || c.expiresAt - Date.now() > 60_000)) return c.access;
  const k = `${siteKey}/${name}`;
  if (!refreshing.has(k)) {
    refreshing.set(k, (async () => {
      try {
        if (!c.refresh) throw new Error("no refresh token");
        const t = await tokenRequest(c, c.tokenEndpoint, { grant_type: "refresh_token", refresh_token: c.refresh, resource: c.resource });
        Object.assign(c, { access: t.access_token, refresh: t.refresh_token ?? c.refresh, expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined, expired: false });
        return c.access;
      } catch (e) {
        console.error(`[mcp-oauth] refresh ${k} failed:`, (e as Error).message);
        c.expired = true;
        return null;
      } finally {
        save();
        refreshing.delete(k);
      }
    })());
  }
  return refreshing.get(k)!;
}

const proxyKey = (siteKey: string) => createHmac("sha256", KEY).update("proxy\0" + siteKey).digest("hex");

/** The agent's MCP config for a turn: a file only this site's agent may read, or null. */
export function mcpOAuthConfig(siteKey: string, siteId: string): string | null {
  const names = Object.keys(db().sites[siteKey] ?? {});
  if (!mcpAuthEnabled || !names.length) return null;
  const mcpServers = Object.fromEntries(names.map((n) => [n, { type: "http", url: `http://127.0.0.1:${PORT}/mcp-proxy/${siteKey}/${n}`, headers: { "x-ak-mcp": proxyKey(siteKey) } }]));
  const dir = join(STATE, "sites", siteId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "mcp-oauth.json");
  writeFileSync(file, JSON.stringify({ mcpServers }), { mode: 0o600 });
  return file;
}

/** One line for the system prompt (owners' turns): how to connect, and what's connected. */
export function mcpOAuthNote(siteKey: string, siteId: string): string {
  if (!mcpAuthEnabled) return "";
  const base = `http://127.0.0.1:${PORT}/sites/${siteId}/mcp-servers`;
  const list = listServers(siteKey);
  return (
    ` To connect an OAuth MCP server for the owner (never use Claude Code's own MCP sign-in or \`claude mcp add\` here: its localhost callback can't reach this box), run \`curl -sS -X POST ${base} -H "x-ak-internal: $AK_INTERNAL_SECRET" -H "Content-Type: application/json" -d '{"url":"<https MCP URL>","page":"<path you were sent from>"}'\` (optional "name", or "client_id"/"client_secret" if it says registration isn't supported) and reply with its signInUrl as a markdown link "Sign in to <name>"; after they approve, its tools load from the next message. List with GET on that URL, disconnect with DELETE ${base}/<name> (same header).` +
    (list.length ? ` Connected MCP servers: ${list.map((s) => s.name + (s.expired ? " (sign-in expired: offer a Reconnect link by running the connect command again)" : "")).join(", ")}.` : "")
  );
}

const page = (title: string, body: string, back?: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${back ? `<meta http-equiv="refresh" content="2;url=${back.replace(/"/g, "&quot;")}">` : ""}<title>${title}</title><body style="font:16px system-ui;background:#0a0a0a;color:#f5f1ea;display:grid;place-items:center;min-height:90vh;margin:0"><main style="max-width:28em;padding:1.5em;text-align:center"><h1 style="font-weight:500;font-size:1.4em">${title}</h1><p style="color:#b8b2a7">${body}</p></main></body>`;
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function mcpAuthRouter(): Router {
  const r = Router();
  r.get("/oauth/callback", async (req, res) => {
    const state = String(req.query.state ?? "");
    const p = pending.get(state);
    pending.delete(state);
    res.set("Cache-Control", "no-store");
    if (!p || p.exp < Date.now()) return res.status(400).send(page("Sign-in link expired", "Ask the agent for a new one."));
    if (req.query.error || !req.query.code) return res.status(400).send(page("Sign-in cancelled", esc(String(req.query.error_description ?? req.query.error ?? "No code came back.")), p.back));
    try {
      const t = await tokenRequest(p.client, p.tokenEndpoint, { grant_type: "authorization_code", code: String(req.query.code), redirect_uri: p.redirect, code_verifier: p.verifier, resource: p.resource });
      (db().sites[p.siteKey] ??= {})[p.name] = { ...p.client, url: p.url, resource: p.resource, tokenEndpoint: p.tokenEndpoint, access: t.access_token, refresh: t.refresh_token, expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined };
      save();
      console.log(`[mcp-oauth] ${p.siteKey} connected ${p.name}`);
      res.send(page(`Connected to ${esc(p.name)}`, `Taking you back… Its tools work from your next message.`, p.back));
    } catch (e) {
      res.status(502).send(page("Couldn't finish signing in", esc((e as Error).message), p.back));
    }
  });

  // The agent's MCP traffic: add the bearer, refresh once on a 401, stream the answer back.
  r.all("/mcp-proxy/:siteKey/:name", async (req, res) => {
    const { siteKey = "", name = "" } = req.params;
    const given = Buffer.from(req.header("x-ak-mcp") ?? "");
    const want = Buffer.from(proxyKey(siteKey));
    if (!mcpAuthEnabled || given.length !== want.length || !timingSafeEqual(given, want)) return res.status(403).json({ error: "forbidden" });
    const c = db().sites[siteKey]?.[name];
    if (!c) return res.status(404).json({ error: `${name} isn't connected` });
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    const headers: Record<string, string> = {};
    for (const h of ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"]) {
      const v = req.header(h);
      if (v) headers[h] = v;
    }
    const body = req.method === "POST" ? JSON.stringify(req.body) : undefined;
    const send = (tok: string) => fetch(c.url, { method: req.method, headers: { ...headers, authorization: `Bearer ${tok}` }, body, signal: ac.signal });
    const expired = () => res.status(503).json({ error: `The sign-in to ${name} expired. Ask the owner to reconnect it.` });
    try {
      let tok = await accessToken(siteKey, name);
      if (!tok) return expired();
      let up = await send(tok);
      if (up.status === 401) {
        void up.body?.cancel();
        tok = await accessToken(siteKey, name, true);
        if (!tok) return expired();
        up = await send(tok);
        if (up.status === 401) {
          void up.body?.cancel();
          c.expired = true;
          save();
          return expired();
        }
      }
      res.status(up.status);
      for (const h of ["content-type", "mcp-session-id", "cache-control"]) {
        const v = up.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      if (!up.body) return res.end();
      res.flushHeaders();
      Readable.fromWeb(up.body as never).on("error", () => res.end()).pipe(res);
    } catch (e) {
      if (!res.headersSent) res.status(502).json({ error: `couldn't reach ${name}: ${(e as Error).message}` });
    }
  });
  return r;
}
