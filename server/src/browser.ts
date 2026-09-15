// Isolated browser tasks — owner-only, one throwaway Chromium per task.
//
// Deliberately disjoint from screen.ts: that module *observes* the browsers the
// agent's own tooling drives (CDP, AK_CDP_PORT, one port per site). Nothing here
// reads that port, connects over CDP, or shares a profile with anything. Each
// task launches its own Chromium against a fresh mkdtemp profile under /tmp,
// routes through the residential SOCKS5 egress, and takes that profile to the
// grave with it — so a task can never disturb a live agent session's cookies,
// storage or jobs.

import type { Request, Response, NextFunction } from "express";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type BrowserContext, type Page } from "playwright-core";

import { requireOwner, type AuthedUser } from "./auth.js";

/** Whole-number env knob. Anything that isn't a finite integer ≥ min — "", "two",
 *  "NaN", "Infinity", "1e999", "-3" — falls back instead of poisoning a limit. */
function envInt(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    console.warn(`[browser] ${name}=${JSON.stringify(raw)} is not a whole number >= ${min} — using ${fallback}`);
    return fallback;
  }
  return n;
}

const MAX_TASKS = envInt("AK_BROWSER_MAX_TASKS", 2);
const TTL_MS = envInt("AK_BROWSER_TTL_MS", 15 * 60_000, 1_000);
const NAV_TIMEOUT_MS = envInt("AK_BROWSER_NAV_TIMEOUT_MS", 30_000, 1_000);
const TEXT_MAX_CHARS = envInt("AK_BROWSER_TEXT_MAX_CHARS", 20_000, 100);
const VIEWPORT = { width: 1280, height: 800 };
// The residential egress (server/tailscale-up.sh). A task that cannot reach it
// fails its navigation — it never silently falls back to the datacenter IP.
const PROXY_SERVER = "socks5://127.0.0.1:1055";

interface Task {
  id: string;
  url: string;
  createdAt: number;
  expiresAt: number;
  profileDir: string;
  context: BrowserContext;
  page: Page;
  ttl: ReturnType<typeof setTimeout>;
  closing: boolean;
  /** Page ops run one at a time, so a navigate and a screenshot can't interleave. */
  queue: Promise<unknown>;
}

const tasks = new Map<string, Task>();
// Launches in flight. Counted with the live tasks so two concurrent creates
// cannot both look at a free slot and both take it: the seat is claimed
// synchronously, before the first await.
let reserved = 0;

function claimSlot(): boolean {
  if (tasks.size + reserved >= MAX_TASKS) return false;
  reserved += 1;
  return true;
}

function releaseSlot(): void {
  reserved = Math.max(0, reserved - 1);
}

/** http(s) only: no file:, data:, javascript:, chrome:, about: … Exported for
 *  src/dev/browser-check.ts. */
export function validUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString();
}

/** Serialize page work per task and bound it, so one wedged op can't pile up. */
function run<T>(task: Task, op: () => Promise<T>): Promise<T> {
  const next = task.queue.then(op, op);
  task.queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function closeTask(task: Task, reason: string): Promise<void> {
  if (task.closing) return;
  task.closing = true;
  clearTimeout(task.ttl);
  tasks.delete(task.id);
  console.log(`[browser] closing task ${task.id} (${reason})`);
  await task.context.close().catch((e) => console.error(`[browser] close failed for ${task.id}`, String(e)));
  await rm(task.profileDir, { recursive: true, force: true }).catch((e) =>
    console.error(`[browser] profile cleanup failed for ${task.id}`, String(e)),
  );
}

/** Close every live task — called from the server's graceful shutdown. */
export async function closeAllBrowserTasks(): Promise<void> {
  await Promise.all([...tasks.values()].map((task) => closeTask(task, "server shutting down")));
}

function snapshot(task: Task): Record<string, unknown> {
  return {
    task_id: task.id,
    url: task.url,
    created_at: new Date(task.createdAt).toISOString(),
    expires_at: new Date(task.expiresAt).toISOString(),
    proxy: PROXY_SERVER,
  };
}

/**
 * requireOwner() also admits runtime-provisioned accounts (allowed-emails.json),
 * every extra ALLOWED_EMAIL entry, and the x-ak-internal / x-ak-relay machine
 * identities. A browser task runs real code against the owner's residential
 * egress, so this narrows to ONE address: TASK_BROWSER_OWNER_EMAIL when set,
 * otherwise the first non-empty ALLOWED_EMAIL entry. Compared trimmed and
 * case-insensitively; "" means nobody and the guard fails closed, so a missing
 * config can never widen access.
 */
function primaryOwnerEmail(): string {
  const explicit = (process.env.TASK_BROWSER_OWNER_EMAIL ?? "").trim().toLowerCase();
  if (explicit) return explicit;
  return (
    (process.env.ALLOWED_EMAIL ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .find((entry) => entry.length > 0) ?? ""
  );
}

export function requirePrimaryOwner(): express.RequestHandler[] {
  const authed = requireOwner();
  const narrow = (req: Request, res: Response, next: NextFunction): void => {
    const owner = primaryOwnerEmail();
    if (!owner) {
      res.status(500).json({ error: "server not configured: set TASK_BROWSER_OWNER_EMAIL or ALLOWED_EMAIL" });
      return;
    }
    const email = (req as Request & { user?: AuthedUser }).user?.email?.toLowerCase() ?? "";
    if (email !== owner) {
      res.status(403).json({ error: "browser tasks are restricted to the primary owner" });
      return;
    }
    next();
  };
  return [authed, narrow];
}

export function browserTasksRouter(): express.Router {
  const router = express.Router();
  const owner = requirePrimaryOwner();
  const json = express.json({ limit: "16kb" });

  const find = (req: Request, res: Response): Task | null => {
    const task = tasks.get(req.params.taskId ?? "");
    if (!task || task.closing) {
      res.status(404).json({ error: "unknown or closed task" });
      return null;
    }
    return task;
  };

  const failed = (res: Response, err: unknown): void => {
    res.status(502).json({ error: String((err as Error)?.message ?? err).slice(0, 300) });
  };

  // Create: launch a fresh browser on a fresh profile and land on the URL.
  router.post("/browser-tasks", owner, json, async (req: Request, res: Response) => {
    const url = validUrl((req.body as { url?: unknown } | undefined)?.url);
    if (!url) {
      res.status(400).json({ error: "url must be an absolute http(s) URL" });
      return;
    }
    if (!claimSlot()) {
      res.status(429).json({ error: `at most ${MAX_TASKS} browser tasks at a time — close one first` });
      return;
    }
    let profileDir: string | null = null;
    let context: BrowserContext | null = null;
    try {
      profileDir = await mkdtemp(join(tmpdir(), "ak-browser-"));
      context = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        proxy: { server: PROXY_SERVER },
        viewport: VIEWPORT,
        // The container runs as root, where Chromium's sandbox refuses to start.
        args: ["--no-sandbox"],
      });
      const page = context.pages()[0] ?? (await context.newPage());
      page.setDefaultTimeout(NAV_TIMEOUT_MS);
      const now = Date.now();
      const task: Task = {
        id: randomUUID(),
        url,
        createdAt: now,
        expiresAt: now + TTL_MS,
        profileDir,
        context,
        page,
        closing: false,
        queue: Promise.resolve(),
        ttl: setTimeout(() => void closeTask(task, "ttl expired"), TTL_MS),
      };
      task.ttl.unref?.();
      tasks.set(task.id, task);
      // Registered before navigating: a slow page still leaves a closable task.
      releaseSlot();
      try {
        await run(task, () => task.page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }));
      } catch (err) {
        await closeTask(task, "initial navigation failed");
        failed(res, err);
        return;
      }
      console.log(`[browser] task ${task.id} open at ${url} (${tasks.size}/${MAX_TASKS})`);
      res.status(201).json(snapshot(task));
    } catch (err) {
      releaseSlot();
      await context?.close().catch(() => {});
      if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {});
      failed(res, err);
    }
  });

  // Status: what this task is looking at right now.
  router.get("/browser-tasks/:taskId", owner, async (req: Request, res: Response) => {
    const task = find(req, res);
    if (!task) return;
    try {
      const [current, title] = await run(task, async () => [task.page.url(), await task.page.title()] as const);
      res.json({ ...snapshot(task), current_url: current, title: title.slice(0, 300) });
    } catch (err) {
      failed(res, err);
    }
  });

  // Navigate an open task to another http(s) URL.
  router.post("/browser-tasks/:taskId/navigate", owner, json, async (req: Request, res: Response) => {
    const task = find(req, res);
    if (!task) return;
    const url = validUrl((req.body as { url?: unknown } | undefined)?.url);
    if (!url) {
      res.status(400).json({ error: "url must be an absolute http(s) URL" });
      return;
    }
    try {
      await run(task, () => task.page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }));
      task.url = url;
      res.json({ ...snapshot(task), current_url: task.page.url() });
    } catch (err) {
      failed(res, err);
    }
  });

  // Visible text, capped so a huge page can't blow up the response.
  router.get("/browser-tasks/:taskId/text", owner, async (req: Request, res: Response) => {
    const task = find(req, res);
    if (!task) return;
    try {
      const text = await run(task, () => task.page.innerText("body"));
      res.json({
        task_id: task.id,
        current_url: task.page.url(),
        text: text.slice(0, TEXT_MAX_CHARS),
        truncated: text.length > TEXT_MAX_CHARS,
      });
    } catch (err) {
      failed(res, err);
    }
  });

  // Viewport PNG (never fullPage — that is the unbounded one).
  router.get("/browser-tasks/:taskId/screenshot", owner, async (req: Request, res: Response) => {
    const task = find(req, res);
    if (!task) return;
    try {
      const png = await run(task, () => task.page.screenshot({ type: "png", fullPage: false }));
      res.setHeader("Cache-Control", "no-store");
      res.type("image/png").send(png);
    } catch (err) {
      failed(res, err);
    }
  });

  // Explicit close — don't wait for the TTL to free the seat.
  router.post("/browser-tasks/:taskId/close", owner, async (req: Request, res: Response) => {
    const task = find(req, res);
    if (!task) return;
    await closeTask(task, "closed by owner");
    res.json({ ok: true, task_id: task.id });
  });

  return router;
}
