// Per-site git checkouts on the Fly volume. Each site has ONE checkout at a
// FIXED absolute path — Claude Code keys its durable session files by a hash of
// the cwd, so the checkout must never move or --resume silently loses the
// session. The agent runs with cwd = the checkout; it edits, commits, and pushes
// from there.
//
// syncCheckout runs at the start of every job (inside the per-site mutex): it
// re-applies the push token, fetches, and hard-resets to the remote branch head so
// each turn starts from a clean, up-to-date tree. gitSummary (after the CLI
// exits) reports what the turn actually did.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, appendFile, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Site } from "./sites.js";

const execFileP = promisify(execFile);

export const DATA_DIR = process.env.AGENT_DATA_DIR ?? "/data";
const CHECKOUTS_DIR = join(DATA_DIR, "checkouts");
const GH_TOKEN = process.env.GH_TOKEN ?? "";

const GIT_USER_NAME = process.env.GIT_AUTHOR_NAME ?? "Agent Keyboard";
const GIT_USER_EMAIL = process.env.GIT_AUTHOR_EMAIL ?? "agent@agentkeyboard.com";

/** Absolute path to a site's checkout. FIXED — never move it (cwd-hashed sessions). */
export function checkoutPath(siteId: string): string {
  return join(CHECKOUTS_DIR, siteId);
}

/** Inject the push token into an https clone URL. Never logged. */
function tokenizedRemote(repo: string): string {
  if (!GH_TOKEN) return repo;
  return repo.replace(/^https:\/\//, `https://x-access-token:${GH_TOKEN}@`);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd,
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

// One in-process FIFO mutex per site: two jobs for the same checkout must never
// run concurrently (they'd fight over the working tree and the durable session
// JSONL). Different sites still run in parallel. Manual acquire/release (not a
// withLock wrapper) because the holder is an async generator that yields status
// frames while it holds the lock.
const siteQueues = new Map<string, Promise<void>>();

/** Acquire a site's FIFO lock. Resolves with release() once the lock is held. */
export function acquireSiteLock(siteId: string): Promise<() => void> {
  const prev = siteQueues.get(siteId) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => held);
  siteQueues.set(siteId, tail);
  // Drop the map entry once the last waiter in the chain releases.
  void tail.finally(() => {
    if (siteQueues.get(siteId) === tail) siteQueues.delete(siteId);
  });
  return prev.then(() => release);
}

// The first clone must not race itself; memoize the in-flight (and resolved)
// clone so concurrent callers await one checkout. On failure, drop it so a
// later call can retry.
const ensuring = new Map<string, Promise<string>>();

/** Clone the site once if missing; configure identity + ignore our staging dir. */
export function ensureCheckout(site: Site): Promise<string> {
  const inflight = ensuring.get(site.id);
  if (inflight) return inflight;
  const p = doEnsureCheckout(site);
  ensuring.set(site.id, p);
  void p.catch(() => ensuring.delete(site.id));
  return p;
}

async function doEnsureCheckout(site: Site): Promise<string> {
  const dir = checkoutPath(site.id);
  if (existsSync(join(dir, ".git"))) return dir;

  await mkdir(CHECKOUTS_DIR, { recursive: true });
  await execFileP(
    "git",
    ["clone", "--branch", site.branch, tokenizedRemote(site.repo), dir],
    { env: process.env, maxBuffer: 16 * 1024 * 1024 },
  );
  await git(dir, ["config", "user.name", GIT_USER_NAME]);
  await git(dir, ["config", "user.email", GIT_USER_EMAIL]);
  // Keep our photo-staging dir out of every diff/status the agent might commit.
  await appendFile(join(dir, ".git", "info", "exclude"), "\n.tmp/\n").catch(() => {});
  return dir;
}

/**
 * Reset a checkout to a clean copy of origin/<branch>. Re-applies the remote URL
 * first — GH_TOKEN is a long-lived fine-grained PAT read from env, and re-setting
 * origin at the start of every job means rotating it is just
 * `fly secrets set GH_TOKEN=…` (the next job picks up the new value). Then
 * fetches, hard-resets, and cleans everything EXCEPT our .tmp staging dir (staged
 * photos for the in-flight job live there). Returns the post-sync HEAD sha
 * (preJobSha). MUST be called inside withSiteLock.
 */
export async function syncCheckout(site: Site): Promise<string> {
  const dir = await ensureCheckout(site);
  await git(dir, ["remote", "set-url", "origin", tokenizedRemote(site.repo)]);
  await git(dir, ["fetch", "origin", site.branch]);
  // Preserve, don't destroy. If a prior (e.g. interrupted) turn left uncommitted
  // work, stash it — recoverable via `git stash pop` — instead of the reset/clean
  // below blowing it away. .tmp is git-ignored, so status/stash never touch the
  // in-flight job's staged photos. Best-effort: a stash failure just falls through
  // to the old hard-reset behaviour, never worse.
  const dirty = (await git(dir, ["status", "--porcelain"]).catch(() => "")).trim();
  if (dirty) {
    await git(dir, [
      "stash",
      "push",
      "--include-untracked",
      "-m",
      `ak-autosync ${new Date().toISOString()}`,
    ]).catch(() => {});
  }
  await git(dir, ["reset", "--hard", `origin/${site.branch}`]);
  await git(dir, ["clean", "-fd", "-e", ".tmp"]);
  const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
  return head;
}

export interface GitSummary {
  changed: boolean; // HEAD moved vs the pre-job sha (the agent committed)
  pushed: boolean; // those commits reached origin/<branch>
  headSha: string;
  branch: string;
  dirty: boolean; // uncommitted changes left in the tree
}

/**
 * Describe what a turn did to the checkout. Called after the CLI exits, inside
 * the same site lock. `changed` = HEAD moved; `pushed` = there are no local
 * commits ahead of origin (i.e. everything the agent committed is on the
 * remote); `dirty` = uncommitted leftovers. `pushBranch` is the branch the agent
 * was told to push to — the deploy `site.branch` by default, or a review branch
 * (config.ts pushBranch, resolved in claude.ts). "Ahead of origin" and the
 * reported `branch` are measured against it so the reply names the right branch.
 */
export async function gitSummary(
  site: Site,
  preJobSha: string,
  pushBranch: string = site.branch,
): Promise<GitSummary> {
  const dir = checkoutPath(site.id);
  // Refresh the remote ref so "ahead of origin" reflects the agent's push.
  await git(dir, ["fetch", "origin", pushBranch]).catch(() => {});
  const headSha = (await git(dir, ["rev-parse", "HEAD"]).catch(() => preJobSha)).trim();
  const ahead = (
    await git(dir, ["rev-list", `origin/${pushBranch}..HEAD`]).catch(() => "")
  ).trim();
  const status = (await git(dir, ["status", "--porcelain"]).catch(() => "")).trim();
  // Ignore our own staging dir when judging "dirty".
  const dirtyLines = status.split("\n").filter((l) => l.trim() && !/\s\.tmp\//.test(l));
  return {
    changed: headSha !== preJobSha,
    pushed: ahead === "",
    headSha,
    branch: pushBranch,
    dirty: dirtyLines.length > 0,
  };
}

export interface CheckoutReset {
  headSha: string;
  branch: string;
  dirty: boolean;
}

/**
 * Restart action reset: discard every local checkout change and land exactly on
 * origin/<branch>. Unlike syncCheckout(), this intentionally does NOT stash
 * dirty work; Restart means "clean slate."
 */
export async function resetCheckoutToOrigin(site: Site): Promise<CheckoutReset> {
  const dir = await ensureCheckout(site);
  await git(dir, ["remote", "set-url", "origin", tokenizedRemote(site.repo)]);
  await git(dir, ["fetch", "origin", site.branch]);
  await git(dir, ["reset", "--hard", `origin/${site.branch}`]);
  await git(dir, ["clean", "-fdx"]);
  const headSha = (await git(dir, ["rev-parse", "HEAD"])).trim();
  const status = (await git(dir, ["status", "--porcelain"]).catch(() => "")).trim();
  return { headSha, branch: site.branch, dirty: status.length > 0 };
}

/** Read a small pointer file inside a checkout's data area (best-effort). */
export async function readDataFile(relPath: string): Promise<string | null> {
  try {
    return (await readFile(join(DATA_DIR, relPath), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

/** Write a small state file under DATA_DIR atomically (tmp + rename) — the CLI
 *  child may be reading the same file. Creates parent dirs as needed. */
export async function writeDataFile(relPath: string, content: string): Promise<void> {
  const path = join(DATA_DIR, relPath);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}
