// Site events (Notes spec 21): one log per live site, read by long-poll
// (`GET /sites/:id/events`, the Cloud MCP's list_events / wait_for_event) and
// pushed to the owner's webhooks. `emit` is the only producer. The last 200
// events per site live in memory and in events.jsonl, so a restart keeps the
// cursor. Webhook retries are in-memory only (receivers dedupe on X-AK-Delivery).

import { createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, readDataFile, writeDataFile } from "./checkouts.js";
import { knobValidate, loadHarness, saveSettings, isPublicHost, type EventType, type Webhook } from "./harness.js";
export { EVENT_TYPES, type EventType } from "./harness.js";
import { parentId } from "./sandboxes.js";
import { getSite } from "./sites.js";

export interface SiteEvent {
  id: string;
  type: EventType;
  site: string;
  at: string;
  data: Record<string, unknown>;
}

const KEEP = 200;
const logs = new Map<string, SiteEvent[]>();
const fileLines = new Map<string, number>(); // lines in events.jsonl
const waiters = new Map<string, Set<() => void>>();
let lastId = 0;

const rel = (site: string) => join("agent-keyboard", "sites", site, "events.jsonl");

async function log(site: string): Promise<SiteEvent[]> {
  let l = logs.get(site);
  if (!l) {
    const raw = (await readDataFile(rel(site))) ?? "";
    l = raw.split("\n").filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line) as SiteEvent];
      } catch {
        return [];
      }
    }).slice(-KEEP);
    if (!logs.has(site)) logs.set(site, l);
    l = logs.get(site)!;
  }
  return l;
}

/** Record an event on the live site (a sandbox's go to its parent, tagged) and fan it out. */
export async function emit(siteId: string, type: EventType, data: Record<string, unknown>): Promise<void> {
  const site = parentId(siteId);
  if (site !== siteId) data = { ...data, site, sandbox: siteId };
  // Increasing per process and across restarts (time-based), fixed width so ids compare as strings.
  lastId = Math.max(Date.now() * 1000, lastId + 1);
  const ev: SiteEvent = { id: lastId.toString(36).padStart(11, "0"), type, site, at: new Date().toISOString(), data };
  const l = await log(site);
  l.push(ev);
  if (l.length > KEEP) l.splice(0, l.length - KEEP);
  // Append; rewrite (trimmed to KEEP) only once the file reaches twice that.
  const lines = (fileLines.get(site) ?? l.length - 1) + 1;
  fileLines.set(site, lines);
  if (lines === 1 || lines >= 2 * KEEP) {
    await writeDataFile(rel(site), l.map((e) => JSON.stringify(e)).join("\n") + "\n").catch(() => {});
    fileLines.set(site, l.length);
  } else await appendFile(join(DATA_DIR, rel(site)), JSON.stringify(ev) + "\n").catch(() => {});
  for (const wake of waiters.get(site) ?? []) wake();
  void deliverAll(site, ev).catch((e) => console.error(`[events] ${site}: webhooks failed`, e));
}

/** Events after `after` (oldest first); with `waitS`, long-poll until one arrives or time is up. */
export async function readEvents(siteId: string, after: string, waitS: number): Promise<{ events: SiteEvent[]; cursor: string }> {
  const site = parentId(siteId);
  const pick = (l: SiteEvent[]) => l.filter((e) => !after || e.id > after);
  let events = pick(await log(site));
  if (!events.length && waitS > 0) {
    await new Promise<void>((resolve) => {
      const set = waiters.get(site) ?? new Set();
      waiters.set(site, set);
      const done = () => (clearTimeout(t), set.delete(done), resolve());
      const t = setTimeout(done, waitS * 1000);
      set.add(done);
    });
    events = pick(await log(site));
  }
  const l = await log(site);
  return { events, cursor: events.at(-1)?.id ?? (after || l.at(-1)?.id || "") };
}

// ─── webhooks ─────────────────────────────────────────────────────────────

/** `t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">` (Stripe-style). */
export function sign(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

function slackText(ev: SiteEvent, domain: string): string {
  const d = ev.data as Record<string, string | undefined>;
  const ask = (d.ask ?? "").replace(/\s+/g, " ").slice(0, 140);
  const where = d.sandbox ? `${domain} (sandbox ${String(d.sandbox).split("--sb-")[1]})` : domain;
  switch (ev.type) {
    case "job.done": return `✓ ${where}: ${ask}`;
    case "job.failed": return `✗ ${where}: ${ask} (${String(d.error ?? "failed").slice(0, 200)})`;
    case "push": return `✓ ${where}: ${ask || d.message} → ${d.url ?? d.commit}`;
    default: return `${ev.type.replace(".", " ")} on ${domain}: ${String(d.sandbox ?? "").split("--sb-")[1] ?? ""}${d.pr ? ` → ${d.pr}` : d.preview_url ? ` → ${d.preview_url}` : ""}`;
  }
}

/** POST once; true on 2xx. Refuses hosts that resolve to private addresses. */
export async function deliver(hook: Webhook, ev: SiteEvent, domain: string, checkHost = true): Promise<boolean> {
  const url = new URL(hook.url);
  if (checkHost) {
    const addrs = await lookup(url.hostname, { all: true }).catch(() => []);
    if (!addrs.length || addrs.some((a) => !isPublicHost(a.address))) return false;
  }
  const body = JSON.stringify(url.hostname === "hooks.slack.com" ? { text: slackText(ev, domain) } : ev);
  const res = await fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "AgentKeyboard-Webhooks",
      "X-AK-Event": ev.type,
      "X-AK-Delivery": ev.id,
      "X-AK-Signature": sign(hook.secret ?? "", body),
    },
    body,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  await res?.body?.cancel().catch(() => {});
  return !!res && res.status >= 200 && res.status < 300;
}

const RETRY_MS = [30_000, 120_000, 600_000];
const MAX_FAILS = 20;
const fails = new Map<string, number>(); // `${site} ${url}` → failures in a row
let onDisabled: (site: string, url: string) => void = () => {};
/** index.ts tells the conversation when a hook is turned off. */
export const setOnHookDisabled = (fn: typeof onDisabled) => (onDisabled = fn);

/** Add (or replace) or remove one hook (the Cloud MCP's site_settings). Returns the new secret once. */
export async function setWebhook(siteId: string, url: string, events: string[], remove: boolean): Promise<{ webhooks: Omit<Webhook, "secret">[]; secret?: string; error?: string }> {
  const site = parentId(siteId);
  const norm = (u: unknown) => {
    try {
      return new URL(String(u)).href;
    } catch {
      return String(u);
    }
  };
  const raw = await readDataFile(join("agent-keyboard", "sites", site, "settings.json"));
  const prev = raw ? (JSON.parse(raw) as { webhooks?: unknown }).webhooks : undefined;
  const hooks = (Array.isArray(prev) ? prev : []).filter((h) => norm((h as Webhook | null)?.url) !== norm(url));
  const secret = remove ? undefined : `whsec_${randomBytes(24).toString("hex")}`;
  if (!remove) hooks.push({ url, events, secret });
  const warnings: string[] = [];
  const valid = (knobValidate("webhooks", hooks, (w) => warnings.push(w)) ?? []) as Webhook[];
  if (!remove && !valid.some((h) => h.url === norm(url))) return { webhooks: [], error: warnings.join("; ") || "invalid webhook" };
  await saveSettings(site, { webhooks: hooks.length ? hooks : undefined });
  return { webhooks: valid.map(({ secret: _, ...h }) => h), ...(secret ? { secret } : {}) };
}

/** Edit the owner's own webhook entries in place (invalid ones stay put, with their warnings). */
async function patchHooks(site: string, fn: (raw: Record<string, unknown>) => unknown): Promise<void> {
  const raw = await readDataFile(join("agent-keyboard", "sites", site, "settings.json"));
  const hooks = raw ? (JSON.parse(raw) as { webhooks?: unknown }).webhooks : undefined;
  if (!Array.isArray(hooks)) return;
  for (const h of hooks) {
    try {
      if (h && typeof h === "object") fn(h as Record<string, unknown>);
    } catch {
      /* an invalid url: leave it */
    }
  }
  await saveSettings(site, { webhooks: hooks });
}

async function deliverAll(site: string, ev: SiteEvent): Promise<void> {
  const settings = (await loadHarness(site)).settings;
  const hooks = settings.webhooks ?? [];
  if (!hooks.length) return;
  // First use: give each hook without a secret one, and save it for the agent to tell the owner.
  if (hooks.some((h) => !h.secret)) {
    for (const h of hooks) h.secret ||= `whsec_${randomBytes(24).toString("hex")}`;
    await patchHooks(site, (raw) => (raw.secret ||= hooks.find((h) => h.url === new URL(String(raw.url)).href)?.secret));
  }
  const domain = getSite(site)?.domain ?? site;
  for (const hook of hooks) {
    if (hook.disabled || !(hook.events.includes("*") || hook.events.includes(ev.type))) continue;
    void attempt(site, hook, ev, domain, 0);
  }
}

async function attempt(site: string, hook: Webhook, ev: SiteEvent, domain: string, n: number): Promise<void> {
  const key = `${site} ${hook.url}`;
  if (await deliver(hook, ev, domain)) {
    fails.delete(key);
    return;
  }
  const count = (fails.get(key) ?? 0) + 1;
  fails.set(key, count);
  if (count >= MAX_FAILS) {
    fails.delete(key);
    await patchHooks(site, (raw) => (new URL(String(raw.url)).href === hook.url ? (raw.disabled = true) : undefined));
    onDisabled(site, hook.url);
    return;
  }
  if (n < RETRY_MS.length) setTimeout(() => void attempt(site, hook, ev, domain, n + 1), RETRY_MS[n]).unref?.();
}
