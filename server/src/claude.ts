// The heart of Agent Keyboard: drive the real Claude Code CLI (`claude -p`)
// against a site's git checkout, streaming the run as a sequence of [event,
// payload] frames. No Agent SDK.
//
// Each site has one durable, auto-compacting Claude Code session, keyed off a
// deterministic session id (uuidv5 of the site's conversationId). The first
// message creates the session (--session-id); every later message resumes it
// (--resume) so the agent keeps its full memory across turns. The CLI runs with
// cwd = the checkout, bypassPermissions, and a short SCOPE_NOTE system prompt;
// it edits code, commits, and pushes to the branch Netlify deploys from.
//
// Stream parsing handles tool-status condensing, stderr-regex session recovery,
// text/thinking delta parsing, authoritative assistant snapshots, and ≤3 retries
// on throttling.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { v5 as uuidv5 } from "uuid";
import type { Site } from "./sites.js";
import {
  DATA_DIR,
  acquireSiteLock,
  syncCheckout,
  checkoutPath,
  gitSummary,
  readDataFile,
} from "./checkouts.js";
import { cleanupUploads } from "./photos.js";

const MODEL = process.env.CLAUDE_MODEL ?? "opus";
const RUN_TIMEOUT_MS = Number(process.env.CLAUDE_RUN_TIMEOUT_MS ?? 900_000);
const ASSISTANT_THROTTLE_MS = 180;
const MAX_ATTEMPTS = 3;

// HOME is where Claude Code keeps its session store; on Fly HOME=/data.
export const CLAUDE_HOME = process.env.HOME ?? DATA_DIR;

const STATE_ROOT = join(DATA_DIR, "agent-keyboard");
const CONVERSATIONS_DIR = join(STATE_ROOT, "conversations"); // session-created markers

// uuidv5 URL namespace: a guaranteed-valid RFC 4122 namespace UUID.
const NAMESPACE = uuidv5.URL;

/** Deterministic session id for a conversation. Same input → same session. */
export function sessionIdFor(conversationId: string): string {
  return uuidv5(conversationId, NAMESPACE);
}

/**
 * The active conversationId for a site. A per-site pointer file lets a future
 * "new chat" endpoint rotate it (start a fresh session); until then it's the
 * default `site:<id>`. Read lazily — no file means the default.
 */
export async function conversationIdFor(siteId: string): Promise<string> {
  const pointer = await readDataFile(join("agent-keyboard", "sites", siteId, "current-conversation"));
  return pointer || `site:${siteId}`;
}

function markerPathFor(conversationId: string): string {
  const safe = conversationId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(CONVERSATIONS_DIR, safe);
}

/** A compact UTC stamp (YYYYMMDD-HHMMSS) — substituted for {ts} in a pushBranch. */
function timestampSlug(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/**
 * The branch this job's commit should land on. No site.pushBranch → the deploy
 * branch (push-to-main, the default). Set → the configured review branch, with
 * {ts} substituted ONCE here so the prompt and gitSummary agree for the whole
 * job (retries included). Never returns site.branch when pushBranch is set — the
 * validator (config.ts) guarantees they differ.
 */
export function resolvePushBranch(site: Site): string {
  if (!site.pushBranch) return site.branch;
  return site.pushBranch.replace(/\{ts\}/g, timestampSlug());
}

// ~6-line operating scope — the ONLY server-authored prompt text. Everything
// else (how to make the change) is the agent's own judgment + the repo's files.
// When pushBranch differs from the deploy branch, the push clause redirects the
// commit to that review branch instead of the live one (nothing deploys).
function scopeNote(site: Site, pushBranch: string = site.branch): string {
  const path = checkoutPath(site.id);
  const lines = [
    `You are the Agent Keyboard, editing the live website ${site.domain}, which is checked out at ${path} — that directory is your working copy and your cwd.`,
    `Modify only files inside this repository; never touch other checkouts, /data, or any server config.`,
  ];
  if (pushBranch === site.branch) {
    lines.push(
      `When the change is complete, commit it with a clear message and push to the "${site.branch}" branch (Netlify deploys the site from it).`,
      `If the push is rejected because the branch moved, run \`git pull --rebase\` and push again.`,
    );
  } else {
    lines.push(
      `When the change is complete, commit it with a clear message. Do NOT push to the live "${site.branch}" branch — instead publish your commit for review by running \`git push --force origin HEAD:${pushBranch}\`, which creates or updates the "${pushBranch}" branch without deploying anything (someone reviews and merges it later).`,
      `If that push is rejected, run \`git fetch origin\` and run the exact same push command again.`,
    );
  }
  lines.push(
    `Your replies are shown in a small chat bubble on the website, so keep them short and plain — a sentence or two, no markdown headers, no code blocks.`,
  );
  return lines.join(" ");
}

/** Build the user turn: a "[Sent from …]" context line, the text, and any photos. */
function buildPrompt(site: Site, opts: { text: string; page: string; attachmentPaths: string[] }): string {
  const page = opts.page || "/";
  const lines = [`[Sent from https://${site.domain}${page}]`, "", opts.text];
  if (opts.attachmentPaths.length) {
    lines.push("");
    lines.push(
      `Photo(s) attached — use the Read tool to view: ${opts.attachmentPaths.join(", ")}`,
    );
  }
  return lines.join("\n");
}

function streamArgs(
  prompt: string,
  sessionId: string,
  resume: boolean,
  site: Site,
  pushBranch: string,
): string[] {
  return [
    ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
    "-p",
    prompt,
    "--model",
    MODEL,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "bypassPermissions",
    // Lean startup: skip user-level
    // settings/skills and MCP discovery — the agent only needs built-in tools
    // + git, and site instructions come from the checkout's own CLAUDE.md.
    "--strict-mcp-config",
    "--setting-sources",
    "project",
    "--append-system-prompt",
    scopeNote(site, pushBranch),
  ];
}

interface ClaudeResult {
  type?: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  session_id?: string;
  total_cost_usd?: number;
  duration_ms?: number;
}

/** Compact one-line label for a tool_use block (the live activity line). */
function condenseToolUse(b: any): string {
  const name = String(b?.name ?? "working");
  const inp = b?.input ?? {};
  const base = (p: unknown) => {
    const s = String(p ?? "");
    return s.split("/").pop() || s;
  };
  switch (name) {
    case "Bash": {
      const cmd = String(inp.command ?? "").replace(/\s+/g, " ").trim();
      return "$ " + (cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd);
    }
    case "Edit":
    case "MultiEdit":
    case "Write":
      return "editing " + base(inp.file_path);
    case "Read":
      return "reading " + base(inp.file_path);
    case "Grep":
      return "searching for " + String(inp.pattern ?? "").slice(0, 40);
    case "Glob":
      return "finding " + String(inp.pattern ?? "");
    case "WebFetch":
      return "fetching " + base(inp.url);
    case "WebSearch":
      return "searching the web";
    case "TodoWrite":
      return "planning";
    default:
      return name.toLowerCase();
  }
}

// Every live CLI child, so SIGTERM/SIGINT can hard-kill them on shutdown.
const activeChildren = new Set<ChildProcess>();
export function killAllChildren(): void {
  for (const c of activeChildren) {
    try {
      c.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export type LowEvent =
  | { t: "delta"; text: string }
  | { t: "thinking"; text: string }
  | { t: "snapshotText"; text: string }
  | { t: "tool"; detail: string };

/**
 * Parse one stream-json line into low-level events (+ a terminal result if this
 * is the result line). Pure and side-effect-free so it can be unit-tested; the
 * spawn loop just fans the events out to its onEvent callback.
 *  - stream_event/content_block_delta text_delta   → { delta }
 *  - stream_event/content_block_delta thinking_delta → { thinking }
 *  - assistant snapshot: tool_use blocks → { tool }, text blocks → { snapshotText }
 *  - result line → result
 */
export function parseStreamLine(line: string): { events: LowEvent[]; result?: ClaudeResult } {
  const out: { events: LowEvent[]; result?: ClaudeResult } = { events: [] };
  const t = line.trim();
  if (!t) return out;
  let evt: any;
  try {
    evt = JSON.parse(t);
  } catch {
    return out;
  }
  if (evt.type === "result") {
    out.result = evt as ClaudeResult;
  } else if (evt.type === "stream_event") {
    const ev = evt.event ?? {};
    const d = ev.delta ?? {};
    if (ev.type === "content_block_delta") {
      if (d.type === "text_delta" && d.text) out.events.push({ t: "delta", text: d.text });
      else if (d.type === "thinking_delta" && d.thinking)
        out.events.push({ t: "thinking", text: d.thinking });
    }
  } else if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
    let msgText = "";
    for (const b of evt.message.content) {
      if (b?.type === "tool_use") out.events.push({ t: "tool", detail: condenseToolUse(b) });
      else if (b?.type === "text") msgText += String(b.text ?? "");
    }
    if (msgText) out.events.push({ t: "snapshotText", text: msgText });
  }
  return out;
}

/**
 * Spawn the CLI and parse its stream-json lines, pushing low-level events to
 * onEvent as they arrive. Returns the child (for teardown) plus a promise that
 * resolves with the final result + captured stderr once the process exits.
 */
function spawnClaude(
  args: string[],
  cwd: string,
  onEvent: (e: LowEvent) => void,
): { child: ChildProcess; done: Promise<{ result?: ClaudeResult; stderr: string }> } {
  // CLAUDE_BIN override: npx/npm prepend every ancestor node_modules/.bin to
  // PATH, which can shadow the real CLI with a stale local install.
  const child = spawn(process.env.CLAUDE_BIN ?? "claude", args, { cwd, env: process.env });
  activeChildren.add(child);
  const rl = createInterface({ input: child.stdout! });
  const done = new Promise<{ result?: ClaudeResult; stderr: string }>((resolve) => {
    let result: ClaudeResult | undefined;
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    rl.on("line", (line) => {
      const { events, result: r } = parseStreamLine(line);
      if (r) result = r;
      for (const e of events) onEvent(e);
    });
    child.on("close", () => {
      clearTimeout(timer);
      activeChildren.delete(child);
      if (timedOut && !stderr) stderr = `agent run timed out after ${RUN_TIMEOUT_MS}ms`;
      resolve({ result, stderr });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      resolve({ result, stderr: `${stderr} ${String((e as Error)?.message ?? e)}`.trim() });
    });
  });
  return { child, done };
}

// A tiny push→pull bridge: spawnClaude pushes frames from an event handler; the
// generator pulls them with `for await`. close() ends the iteration.
class FrameQueue<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(item: T): void {
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }
  close(): void {
    this.closed = true;
    let w: ((r: IteratorResult<T>) => void) | undefined;
    while ((w = this.waiters.shift())) w({ value: undefined as unknown as T, done: true });
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      const r = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (r.done) return;
      yield r.value;
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isThrottle = (s: string) => /(rate.?limit|overloaded|too many requests|429)/i.test(s);

export type Frame = [string, unknown];

/**
 * Run one message against a site as an async generator of [event, payload]
 * frames. jobs.ts drains it (holding the global Semaphore(2)); the finally runs
 * on natural completion AND on gen.return() teardown, so the site lock is
 * always released and the child always killed.
 *
 * Frames: status(queued|syncing|starting|thinking|tool|retrying) →
 * assistant(full-replace text) → terminal result | error.
 */
export async function* runMessageJob(
  site: Site,
  opts: { text: string; page: string; attachmentPaths: string[] },
): AsyncGenerator<Frame, void, unknown> {
  yield ["status", { phase: "queued", detail: "Waiting for a free slot" }];

  let release: (() => void) | undefined;
  let child: ChildProcess | null = null;
  try {
    release = await acquireSiteLock(site.id);

    yield ["status", { phase: "syncing", detail: `Syncing ${site.domain}` }];
    const preJobSha = await syncCheckout(site);
    const dir = checkoutPath(site.id);
    // Resolve the push target once — a {ts} placeholder must not drift between
    // the prompt, retries, and gitSummary. Equals site.branch unless pushBranch is set.
    const pushBranch = resolvePushBranch(site);

    const conversationId = await conversationIdFor(site.id);
    const sessionId = sessionIdFor(conversationId);
    const marker = markerPathFor(conversationId);
    mkdirSync(CONVERSATIONS_DIR, { recursive: true });
    let resume = existsSync(marker);
    const prompt = buildPrompt(site, opts);

    yield ["status", { phase: "starting", detail: "Thinking…" }];

    let result: ClaudeResult | undefined;
    let lastErr = "";
    let recovered = false; // session create↔resume flip is a one-shot
    let attempt = 0;

    while (attempt < MAX_ATTEMPTS) {
      const queue = new FrameQueue<Frame>();
      let streamed = ""; // accumulated text deltas
      let snapshot = ""; // accumulated authoritative snapshot text
      let lastAssistantEmit = 0;
      let thinkingTail = "";
      let lastThinkingEmit = 0;

      const best = () => (streamed.length >= snapshot.length ? streamed : snapshot);
      const emitAssistant = (force = false) => {
        const now = Date.now();
        if (force || now - lastAssistantEmit >= ASSISTANT_THROTTLE_MS) {
          lastAssistantEmit = now;
          const text = best();
          if (text) queue.push(["assistant", { text }]);
        }
      };

      const { child: c, done } = spawnClaude(
        streamArgs(prompt, sessionId, resume, site, pushBranch),
        dir,
        (e) => {
          if (e.t === "delta") {
            streamed += e.text;
            emitAssistant();
          } else if (e.t === "snapshotText") {
            snapshot += e.text;
            emitAssistant();
          } else if (e.t === "thinking") {
            thinkingTail = (thinkingTail + e.text).slice(-160);
            const now = Date.now();
            if (now - lastThinkingEmit >= ASSISTANT_THROTTLE_MS) {
              lastThinkingEmit = now;
              const detail = thinkingTail.split(/\s+/).join(" ").trim().slice(-120);
              queue.push(["status", { phase: "thinking", detail }]);
            }
          } else if (e.t === "tool") {
            queue.push(["status", { phase: "tool", detail: e.detail }]);
          }
        },
      );
      child = c;
      const settled = done.finally(() => queue.close());
      for await (const frame of queue) yield frame;
      const out = await settled;
      child = null;
      result = out.result;
      lastErr = out.stderr || (result?.is_error ? String(result?.result ?? "") : "");

      if (result && !result.is_error) break;

      // Session-store recovery: flip create↔resume once,
      // doesn't consume a rate-limit attempt.
      if (!recovered && !result && resume && /no conversation|not found/i.test(lastErr)) {
        recovered = true;
        resume = false;
        continue;
      }
      if (!recovered && !result && !resume && /already (in use|exists)/i.test(lastErr)) {
        recovered = true;
        resume = true;
        continue;
      }

      // Throttling backoff: ≤3 attempts, growing delay.
      attempt++;
      if (attempt < MAX_ATTEMPTS && isThrottle(lastErr)) {
        yield ["status", { phase: "retrying", detail: `attempt ${attempt} throttled; backing off` }];
        await sleep(2_000 * attempt);
        continue;
      }
      break;
    }

    // A result means the session was created/resumed — resume next turn.
    if (result) await writeFile(marker, sessionId).catch(() => {});

    if (result && !result.is_error) {
      const git = await gitSummary(site, preJobSha, pushBranch);
      const reply = (result.result ?? "").toString().trim();
      yield [
        "result",
        {
          reply,
          git,
          usage: {
            cost_usd: result.total_cost_usd ?? null,
            duration_ms: result.duration_ms ?? null,
          },
          conversation_id: conversationId,
        },
      ];
    } else {
      const detail = (lastErr || result?.result || "The agent did not return a result.")
        .toString()
        .slice(0, 500);
      yield ["error", { kind: isThrottle(detail) ? "rate_limited" : "agent_failed", detail }];
    }
  } catch (err) {
    yield ["error", { kind: "server_error", detail: String((err as Error)?.message ?? err).slice(0, 500) }];
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await cleanupUploads(site.id, opts.attachmentPaths).catch(() => {});
    release?.();
  }
}
