// Sandboxes: a private copy of a site on its own `ak/<slug>` branch, with its own
// checkout, conversation (forked from the live one) and preview URL. A sandbox is
// just a virtual Site (id `<site>--sb-<slug>`), so locks, sync, sessions and every
// /sites/:id route work unchanged. The registry is a JSON file on the volume.
// See the "Sandboxes PRD + tech design" note.

import { readFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, checkoutPath, createRemoteBranch, ensureCheckout, git, lastUsed, removeCheckout, tryAcquireSiteLock, writeDataFile } from "./checkouts.js";
import type { Site } from "./config.js";

export interface Sandbox {
  id: string; // `<parent>--sb-<slug>`
  parent: string;
  branch: string; // ak/<slug>
  url: string; // preview origin + "/"
  forkFrom?: string;
  createdBy?: string;
  createdAt: string;
  publishedAt?: string;
  pr?: string; // the merged PR's URL
  warnedAt?: string; // told it'll be archived for being idle
  abandonedAt?: string; // archived for being idle
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

export const getSandbox = (id: string): Sandbox | undefined => registry.get(id);

/** Why a sandbox no longer takes messages, or undefined while it's open. */
export function closedReason(sb: Sandbox | undefined): string | undefined {
  if (sb?.publishedAt) return "was published to live";
  if (sb?.abandonedAt) return `was archived after ${IDLE_DAYS} idle days`;
  return undefined;
}

/** A live site's open sandboxes, most recently used first (the bar's switcher). */
export async function listSandboxes(parent: string) {
  const open = [...registry.values()].filter((sb) => sb.parent === parent && !closedReason(sb));
  const rows = await Promise.all(
    open.map(async (sb) => ({
      name: sb.id.split(SEP)[1]!,
      url: sb.url,
      createdBy: sb.createdBy ?? null,
      lastActivity: new Date(await lastUsed(checkoutPath(sb.id))).toISOString(),
    })),
  );
  return rows.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

const save = () => writeDataFile(FILE, JSON.stringify([...registry.values()], null, 1));

/** Close a sandbox: delete its branch, archive its notes on live, record why. */
async function retire(sb: Sandbox, parent: Site, mark: Partial<Sandbox>): Promise<void> {
  await gh(parent.repo, `/git/refs/heads/${sb.branch}`, { method: "DELETE" }).catch(() => {});
  // Notes made or edited here are archived on live, not merged back into its notes.
  const slug = sb.id.split(SEP)[1]!;
  await cp(join(checkoutPath(sb.id), ".tmp", "notes"), join(checkoutPath(parent.id), ".tmp", "notes-archive", slug), { recursive: true }).catch(() => {});
  Object.assign(sb, mark);
  await save();
}

const IDLE_DAYS = 14;
const WARN_DAYS = 2;
const DAY_MS = 86_400_000;

/**
 * Archive sandboxes nobody has used for IDLE_DAYS. Each is warned first (via
 * `warn`, WARN_DAYS ahead); any activity after the warning restarts the clock.
 * Skips a sandbox whose job is running.
 */
export async function pruneSandboxes(
  getParent: (id: string) => Site | null,
  warn: (sb: Sandbox) => Promise<void>,
  now = Date.now(),
): Promise<void> {
  for (const sb of registry.values()) {
    const parent = getParent(sb.parent);
    if (!parent || closedReason(sb)) continue;
    const used = await lastUsed(checkoutPath(sb.id));
    const warned = sb.warnedAt ? Date.parse(sb.warnedAt) : 0;
    if (warned > used && now - warned >= WARN_DAYS * DAY_MS) {
      const release = tryAcquireSiteLock(sb.id);
      if (!release) continue;
      try {
        await retire(sb, parent, { abandonedAt: new Date(now).toISOString() });
        await removeCheckout(sb.id);
        console.log(`[sandbox] ${sb.id}: archived after ${IDLE_DAYS} idle days`);
      } finally {
        release();
      }
    } else if (warned <= used && now - used >= (IDLE_DAYS - WARN_DAYS) * DAY_MS) {
      await warn(sb).catch(() => {});
      sb.warnedAt = new Date(now).toISOString();
      await save();
    }
  }
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
  await save();
  await ensureCheckout(sandboxSite(sb.id, () => parent)!);
  const notes = (dir: string) => join(dir, ".tmp", "notes");
  await cp(notes(checkoutPath(parent.id)), notes(checkoutPath(sb.id)), { recursive: true }).catch(() => {});
  return sb;
}

const gh = (repo: string, path: string, init: RequestInit = {}) =>
  fetch(`https://api.github.com/repos/${new URL(repo).pathname.slice(1).replace(/\.git$/, "")}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN ?? ""}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });

/**
 * Publish a sandbox to live: squash its branch into one commit authored by `by`
 * (everyone else who committed gets a Co-authored-by trailer), open a PR and
 * rebase-merge it (which keeps that author), delete the branch, then wait for
 * the live site to change. The branch must already be rebased onto live — the
 * sandbox's agent does that (and resolves conflicts) before asking to publish.
 */
export async function publishSandbox(
  site: Site,
  by: string,
  title: string,
  summary: string,
): Promise<{ pr: string; live: boolean }> {
  const sb = registry.get(site.id)!;
  const parent = site.sandboxOf!;
  const dir = checkoutPath(site.id);
  const base = `origin/${parent.branch}`;
  const head = `origin/${sb.branch}`;
  await git(dir, ["fetch", "origin", `+refs/heads/${parent.branch}:refs/remotes/${base}`, `+refs/heads/${sb.branch}:refs/remotes/${head}`]);
  const rebased = await git(dir, ["merge-base", "--is-ancestor", base, head]).then(() => true, () => false);
  if (!rebased) throw new Error(`"${sb.branch}" isn't rebased onto the latest "${parent.branch}" — rebase, push, then publish again`);
  const commits = (await git(dir, ["log", "--reverse", "--format=%an <%ae>%x09%s", `${base}..${head}`])).trim().split("\n").filter(Boolean);
  if (!commits.length) throw new Error("nothing to publish — the sandbox has no changes");
  const agent = (await git(dir, ["config", "user.email"]).catch(() => "")).trim();
  const coAuthors = [...new Set(commits.map((c) => c.split("\t")[0]!))].filter(
    (a) => !a.includes(`<${by}>`) && !(agent && a.includes(`<${agent}>`)),
  );
  const message = [
    title,
    "",
    summary,
    "",
    `Published from sandbox ${sb.branch}:`,
    ...commits.map((c) => `- ${c.split("\t")[1]}`),
    ...(coAuthors.length ? ["", ...coAuthors.map((a) => `Co-authored-by: ${a}`)] : []),
  ].join("\n");
  const tip = (await git(dir, ["rev-parse", head])).trim();
  const sha = (
    await git(dir, ["commit-tree", `${head}^{tree}`, "-p", base, "-m", message], {
      ...process.env,
      GIT_AUTHOR_NAME: by.split("@")[0]!,
      GIT_AUTHOR_EMAIL: by,
    })
  ).trim();
  await git(dir, ["push", `--force-with-lease=refs/heads/${sb.branch}:${tip}`, "origin", `${sha}:refs/heads/${sb.branch}`]);

  const body = `${summary}\n\nPublished by ${by} from the Agent Keyboard sandbox ${sb.branch} (created by ${sb.createdBy ?? "unknown"}).`;
  let res = await gh(parent.repo, "/pulls", { method: "POST", body: JSON.stringify({ title, head: sb.branch, base: parent.branch, body }) });
  let pr = (await res.json().catch(() => null)) as { number?: number; html_url?: string } | null;
  if (res.status === 422) {
    // Already open (an earlier publish that failed later on): reuse it.
    const owner = new URL(parent.repo).pathname.split("/")[1];
    res = await gh(parent.repo, `/pulls?state=open&head=${owner}:${encodeURIComponent(sb.branch)}`);
    pr = ((await res.json().catch(() => [])) as (typeof pr)[])[0] ?? null;
  }
  if (!pr?.number) throw new Error(`couldn't open the PR (GitHub ${res.status})`);
  const before = await liveBody(parent);
  res = await gh(parent.repo, `/pulls/${pr.number}/merge`, { method: "PUT", body: JSON.stringify({ merge_method: "rebase", sha }) });
  if (res.status === 405) {
    // Rebase merging is turned off on this repo: squash with our message instead.
    res = await gh(parent.repo, `/pulls/${pr.number}/merge`, {
      method: "PUT",
      body: JSON.stringify({ merge_method: "squash", sha, commit_title: title, commit_message: message.split("\n").slice(2).join("\n") }),
    });
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(`GitHub couldn't merge ${pr.html_url}: ${err?.message ?? res.status} — if ${parent.branch} moved, rebase and publish again`);
  }
  await retire(sb, parent, { publishedAt: new Date().toISOString(), pr: pr.html_url });
  let live = false;
  for (const end = Date.now() + 3 * 60_000; !live && Date.now() < end; await new Promise((r) => setTimeout(r, 5000))) {
    const now = await liveBody(parent);
    live = now !== null && now !== before;
  }
  return { pr: pr.html_url!, live };
}

/** The live home page's body, to notice when a new deploy is serving. */
const liveBody = (site: Site) =>
  fetch(`https://${site.domain}/`, { signal: AbortSignal.timeout(10_000) })
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null);

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
