// Sandboxes: a private copy of a site on its own `ak/<slug>` branch, with its own
// checkout, conversation (forked from the live one) and preview URL. A sandbox is
// just a virtual Site (id `<site>--sb-<slug>`), so locks, sync, sessions and every
// /sites/:id route work unchanged. The registry is a JSON file on the volume.
// See the "Sandboxes PRD + tech design" note.

import { readFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, checkoutPath, createRemoteBranch, ensureCheckout, writeDataFile } from "./checkouts.js";
import type { Site } from "./config.js";

export interface Sandbox {
  id: string; // `<parent>--sb-<slug>`
  parent: string;
  branch: string; // ak/<slug>
  url: string; // preview origin + "/"
  forkFrom?: string;
  createdBy?: string;
  createdAt: string;
}

const FILE = "agent-keyboard/sandboxes.json";
const SEP = "--sb-";
const registry = new Map<string, Sandbox>(load().map((s) => [s.id, s]));

function load(): Sandbox[] {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, FILE), "utf8")) as Sandbox[];
  } catch {
    return [];
  }
}

/** The live site id a (possibly sandbox) site id belongs to. */
export function parentId(siteId: string): string {
  return siteId.split(SEP)[0]!;
}

/** The virtual Site for a sandbox id, or null. */
export function sandboxSite(id: string, getParent: (id: string) => Site | null): Site | null {
  const sb = registry.get(id);
  const parent = sb && getParent(sb.parent);
  if (!sb || !parent) return null;
  return {
    id,
    repo: parent.repo,
    branch: sb.branch,
    domain: new URL(sb.url).host,
    ...(parent.guest ? { guest: true } : {}),
    ...(parent.sessionIdleMs ? { sessionIdleMs: parent.sessionIdleMs } : {}),
    ...(sb.forkFrom ? { forkFrom: sb.forkFrom } : {}),
    sandboxOf: parent,
  };
}

/** The sandbox whose preview is served from this browser Origin. */
export function sandboxForOrigin(origin: string | undefined): Sandbox | null {
  if (!origin) return null;
  for (const sb of registry.values()) if (new URL(sb.url).origin === origin) return sb;
  return null;
}

/** `ak/<slug>` → its preview URL under the site's template. */
export function previewUrl(site: Site, branch: string): string {
  const b = branch.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return new URL(site.sandbox!.preview.replace(/\{branch\}/g, b).replace(/\{domain\}/g, site.domain)).origin + "/";
}

/** Create the branch, register the sandbox, clone it and copy the notes over. */
export async function createSandbox(
  parent: Site,
  name: string,
  opts: { forkFrom?: string; createdBy?: string },
): Promise<Sandbox> {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "") || "sandbox";
  let slug = base;
  for (let i = 2; registry.has(`${parent.id}${SEP}${slug}`); i++) slug = `${base}-${i}`;
  const branch = `ak/${slug}`;
  await createRemoteBranch(parent, branch);
  const sb: Sandbox = {
    id: `${parent.id}${SEP}${slug}`,
    parent: parent.id,
    branch,
    url: previewUrl(parent, branch),
    ...(opts.forkFrom ? { forkFrom: opts.forkFrom } : {}),
    ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
    createdAt: new Date().toISOString(),
  };
  registry.set(sb.id, sb);
  await writeDataFile(FILE, JSON.stringify([...registry.values()], null, 1));
  await ensureCheckout(sandboxSite(sb.id, () => parent)!);
  const notes = (dir: string) => join(dir, ".tmp", "notes");
  await cp(notes(checkoutPath(parent.id)), notes(checkoutPath(sb.id)), { recursive: true }).catch(() => {});
  return sb;
}

/** Poll the preview until the host has deployed it, up to `ms`. A fresh Netlify
 *  branch deploy flaps 200/404 for a few seconds, so ready = 3 2xx in a row. */
export async function waitForPreview(url: string, ms = 6 * 60_000): Promise<boolean> {
  let streak = 0;
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 5000))) {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    streak = res?.ok ? streak + 1 : 0;
    if (streak >= 3) return true;
  }
  return false;
}

// The live job that asked for a sandbox redirects its user there when its turn
// ends: jobs.ts adds `sandbox_url` to that job's next result frame.
const redirects = new Map<string, string>();
export function setSandboxRedirect(siteId: string, pageSlug: string, url: string): void {
  redirects.set(`${siteId}\n${pageSlug}`, url);
}
export function takeSandboxRedirect(siteId: string, pageSlug: string): string | undefined {
  const key = `${siteId}\n${pageSlug}`;
  const url = redirects.get(key);
  redirects.delete(key);
  return url;
}
