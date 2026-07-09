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
import { randomUUID } from "node:crypto";
import {
  DATA_DIR,
  acquireSiteLock,
  syncCheckout,
  checkoutPath,
  gitSummary,
  readDataFile,
  writeDataFile,
} from "./checkouts.js";
import { cleanupUploads, resetOutputs, collectOutputs } from "./photos.js";
import {
  CONTEXT_WINDOW_TOKENS,
  clearCompactFlag,
  fallbackHarness,
  extractReplyDirectives,
  harnessNote,
  loadHarness,
  readLastUsage,
  saveSettings,
  writeLastUsage,
  type ResolvedHarness,
  type TurnUsage,
} from "./harness.js";
import { sessionFilePath } from "./conversation.js";
import { readFile } from "node:fs/promises";

// NaN-guarded env int: a malformed value must not become setTimeout(fn, NaN)
// (which fires immediately and would SIGKILL every spawn on the next tick).
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
// 0 = no timeout. Agent Keyboard runs are meant to be long (big multi-file
// changes, browser verification, image gen), so a run is unbounded by default.
// Set CLAUDE_RUN_TIMEOUT_MS to a positive value to re-arm a hard ceiling.
const RUN_TIMEOUT_MS = envInt("CLAUDE_RUN_TIMEOUT_MS", 0);
const COMPACT_TIMEOUT_MS = envInt("CLAUDE_COMPACT_TIMEOUT_MS", 300_000);
const ASSISTANT_THROTTLE_MS = 180;
const MAX_ATTEMPTS = 3;
// Experimental streaming-input mode: deliver the turn on stdin (--input-format
// stream-json) instead of one-shot -p, so a run can later stay open for follow-up
// messages. Off by default; enable per deploy (AK_STREAMING_INPUT=1) while it's
// being proven. Milestone 1 still closes stdin after one message (≡ -p behavior).
const STREAMING_INPUT = process.env.AK_STREAMING_INPUT === "1";
// M2 (keep-alive multi-turn session) is behind its OWN flag, so deploying M2 code
// leaves the verified M1 behaviour (AK_STREAMING_INPUT single-message) untouched
// until this is deliberately flipped on (alongside the widget changes).
export const STREAMING_SESSION = process.env.AK_STREAMING_SESSION === "1";
const SESSION_IDLE_MS = envInt("AK_SESSION_IDLE_MS", 180_000); // close stdin after 3 min idle
const SESSION_MAX_MS = envInt("AK_SESSION_MAX_MS", 3_600_000); // absolute session lifetime cap (1h)

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

/**
 * Clear the context: point the site at a brand-new conversation. The next turn
 * gets a fresh Claude Code session (no memory) and the conversation history
 * reads empty (it's keyed off the new session). Destructive — the old session's
 * memory and transcript are abandoned. Returns the new conversationId.
 */
export async function rotateConversation(siteId: string): Promise<string> {
  const next = `site:${siteId}:${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  await writeDataFile(join("agent-keyboard", "sites", siteId, "current-conversation"), next);
  return next;
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
    `Modify only files inside this repository. Everything else under /data is off-limits — other checkouts, other sites' state, server config, auth files — with exactly two exceptions you own: your harness settings file (described below) and your skills directory ${join(CLAUDE_HOME, ".claude", "skills")}, where you may install or edit skills to gain new capabilities (they load from the next turn).`,
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
    `Follow the "ponytail" skill on every change: ship the laziest solution that actually works. Question whether the change is even needed (YAGNI); reuse what already lives in the repo; prefer the platform, the standard library, and existing dependencies over new ones; make the shortest diff that fixes the root cause; and match the site's existing style. No unrequested abstractions, scaffolding, or files. Never lazy about understanding the problem or about validation, error handling, security, and accessibility.`,
    `Your replies render in a small chat panel with simple markdown: short paragraphs, "-" bullet lists, numbered lists, **bold**, \`inline code\`, [links](https://example.com), short fenced code blocks, and small headings all work; tables do not render, so never use them. Keep replies concise — a couple of sentences, or a short list when structure helps.`,
    `When you need the user to pick between a few discrete options, or to confirm an irreversible action (like clearing context), present the choices as a fenced code block whose info string is \`options\`, one option per line. The panel turns each line into a tappable button that sends that exact line back as the user's next message — so word each option as the message you want to receive (e.g. "Yes, clear the context"). Use it only for genuine pick-one or confirm moments, never for ordinary lists.`,
    `To show the user an image in the chat, save it (PNG/JPG/GIF/WebP) into the ${path}/.tmp/outputs/ folder — create the folder if needed; anything you leave there is displayed to the user alongside your reply. You can curl an image URL into that folder.`,
    `If this site embeds the Agent Keyboard widget (a <script src=".../widget.js" data-site=…> tag) and you create a new page, copy that same embed onto the new page so the bar appears there too — unless the site uses a shared layout/template that already includes it.`,
  );
  return lines.join(" ");
}

/** Build the user turn: a "[Sent from …]" context line, the text, and any attachments. */
function buildPrompt(site: Site, opts: { text: string; page: string; attachmentPaths: string[] }): string {
  const page = opts.page || "/";
  const lines = [`[Sent from https://${site.domain}${page}]`, "", opts.text];
  if (opts.attachmentPaths.length) {
    lines.push("");
    lines.push(
      `Attachment(s) attached — use the Read tool to inspect: ${opts.attachmentPaths.join(", ")}`,
    );
  }
  return lines.join("\n");
}

/** A stream-json user turn (one JSON line) for --input-format stream-json. */
function userMessageLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
}

/**
 * Injects follow-up user turns into a running streaming session. The append
 * endpoint calls push(); the session runner attach()es a sink that writes each to
 * the CLI's stdin. Buffers until a sink attaches; after close() nothing more is
 * accepted (returns false so the caller can fall back to starting a fresh job).
 */
export class InputChannel {
  private sink: ((text: string) => void) | null = null;
  private buffered: string[] = [];
  private closed = false;
  push(text: string): boolean {
    if (this.closed) return false;
    if (this.sink) this.sink(text);
    else this.buffered.push(text);
    return true;
  }
  attach(sink: (text: string) => void): void {
    this.sink = sink;
    for (const t of this.buffered) sink(t);
    this.buffered = [];
  }
  close(): void {
    this.closed = true;
    this.sink = null;
  }
}

function streamArgs(
  prompt: string,
  sessionId: string,
  resume: boolean,
  site: Site,
  pushBranch: string,
  harness: ResolvedHarness,
  usage: TurnUsage | null,
  streaming: boolean,
): string[] {
  return [
    ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
    // Streaming-input: the turn arrives as a stream-json line on stdin (-p with no
    // prompt). Classic one-shot: the prompt is passed inline via -p.
    ...(streaming ? ["-p", "--input-format", "stream-json"] : ["-p", prompt]),
    // Model / effort / permission-mode come from the per-site harness settings
    // (harness.ts); with no settings file the defaults reproduce the historical
    // hardcoded values (--model $CLAUDE_MODEL, --permission-mode bypassPermissions).
    ...harness.args,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // Skip MCP discovery (the agent only needs built-in tools + git), but DO
    // load user-level settings/skills: ~/.claude/skills on the volume holds the
    // seeded skills (server/skills/) plus anything the agent installs itself.
    "--strict-mcp-config",
    "--setting-sources",
    "user,project",
    "--append-system-prompt",
    scopeNote(site, pushBranch) + " " + harnessNote(site.id, harness, usage),
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
    case "Task": {
      const desc = String(inp.description ?? inp.subagent_type ?? "a subagent").replace(/\s+/g, " ").trim();
      return "delegating: " + (desc.length > 60 ? desc.slice(0, 60) + "…" : desc);
    }
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
  | { t: "tool"; detail: string }
  | { t: "todos"; items: { content: string; status: string }[] }
  | { t: "result"; result: ClaudeResult }
  | { t: "usage"; contextTokens: number };

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
    // Also surface as an event so a multi-turn streaming session can react to each
    // turn boundary (the classic runner ignores it and reads out.result instead).
    out.events.push({ t: "result", result: evt as ClaudeResult });
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
    const tools: string[] = [];
    let todos: { content: string; status: string }[] | null = null;
    for (const b of evt.message.content) {
      if (b?.type === "tool_use") {
        // TodoWrite carries the full task list on every call — surface it as a
        // live checklist (a `todos` frame the widget replaces in place), on top
        // of the one-line "planning" tool status.
        if (b.name === "TodoWrite" && Array.isArray(b.input?.todos)) {
          const items = b.input.todos
            .map((td: any) => ({
              content: String(td?.content ?? td?.activeForm ?? "").slice(0, 200),
              status: String(td?.status ?? "pending"),
            }))
            .filter((td: { content: string }) => td.content);
          if (items.length) todos = items;
        }
        tools.push(condenseToolUse(b));
      } else if (b?.type === "text") msgText += String(b.text ?? "");
    }
    // Emit this message's text BEFORE its tool_use(s), so the spawn loop can
    // reset the live text on the tool (a tool call ends the message) without
    // dropping the text that preceded it.
    if (msgText) out.events.push({ t: "snapshotText", text: msgText });
    if (todos) out.events.push({ t: "todos", items: todos });
    for (const d of tools) out.events.push({ t: "tool", detail: d });
    // Approximate context size = this request's full input + output. Some rows
    // carry placeholder input_tokens (a known stream-json quirk) — the caller
    // keeps the max across the run, and tiny totals are dropped here.
    const u = evt.message?.usage;
    if (u && typeof u === "object") {
      const total =
        (Number(u.input_tokens) || 0) +
        (Number(u.cache_read_input_tokens) || 0) +
        (Number(u.cache_creation_input_tokens) || 0) +
        (Number(u.output_tokens) || 0);
      if (total > 1_000) out.events.push({ t: "usage", contextTokens: total });
    }
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
  opts: { extraEnv?: Record<string, string>; timeoutMs?: number; stdin?: string; keepStdinOpen?: boolean } = {},
): {
  child: ChildProcess;
  done: Promise<{ result?: ClaudeResult; stderr: string }>;
  writeInput: (line: string) => void;
  closeInput: () => void;
} {
  // CLAUDE_BIN override: npx/npm prepend every ancestor node_modules/.bin to
  // PATH, which can shadow the real CLI with a stale local install.
  const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS;
  const child = spawn(process.env.CLAUDE_BIN ?? "claude", args, {
    cwd,
    env: opts.extraEnv ? { ...process.env, ...opts.extraEnv } : process.env,
    // Classic: stdin = ignore → the CLI sees EOF immediately (prompt goes via -p),
    // dropping both the "no stdin data in 3s" warning and that 3s startup wait.
    // Streaming-input: pipe stdin so we can write the turn as a stream-json line.
    stdio: [opts.stdin != null || opts.keepStdinOpen ? "pipe" : "ignore", "pipe", "pipe"],
  });
  activeChildren.add(child);
  const writeInput = (line: string) => {
    try {
      child.stdin?.write(line);
    } catch {
      /* stdin closed / child gone */
    }
  };
  const closeInput = () => {
    try {
      child.stdin?.end();
    } catch {
      /* already closed */
    }
  };
  if (opts.stdin != null) {
    // Deliver the initial turn. Single-message mode (M1) then EOFs so the CLI
    // exits like -p; keepStdinOpen (M2 session) leaves stdin open for follow-ups.
    writeInput(opts.stdin);
    if (!opts.keepStdinOpen) closeInput();
  }
  const rl = createInterface({ input: child.stdout! });
  const done = new Promise<{ result?: ClaudeResult; stderr: string }>((resolve) => {
    let result: ClaudeResult | undefined;
    let stderr = "";
    let timedOut = false;
    // Only arm a kill-timer when a positive ceiling is set (the compact turn
    // passes one; the main run defaults to 0 = unbounded).
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeoutMs)
        : null;
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    rl.on("line", (line) => {
      const { events, result: r } = parseStreamLine(line);
      if (r) result = r;
      for (const e of events) onEvent(e);
    });
    child.on("close", () => {
      if (timer) clearTimeout(timer);
      activeChildren.delete(child);
      if (timedOut && !stderr) stderr = `agent run timed out after ${timeoutMs}ms`;
      resolve({ result, stderr });
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      activeChildren.delete(child);
      resolve({ result, stderr: `${stderr} ${String((e as Error)?.message ?? e)}`.trim() });
    });
  });
  return { child, done, writeInput, closeInput };
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

/** Count compact boundaries in the session log (to verify an on-demand compact). */
async function countCompactBoundaries(sessionId: string, cwd: string): Promise<number> {
  const path = await sessionFilePath(sessionId, cwd);
  if (!path) return 0;
  try {
    const txt = await readFile(path, "utf8");
    return (txt.match(/"subtype":\s*"compact_boundary"/g) || []).length;
  } catch {
    return 0;
  }
}

/**
 * On-demand compaction: run `/compact` as a dedicated headless turn and verify a
 * new compact_boundary actually landed in the session log (slash commands in -p
 * mode are not guaranteed — auto-compaction remains the safety net either way).
 * Uses the site's harness args so compaction runs on the configured model.
 */
async function runCompactTurn(sessionId: string, dir: string, harness: ResolvedHarness): Promise<boolean> {
  const before = await countCompactBoundaries(sessionId, dir);
  const args = [
    "--resume",
    sessionId,
    "-p",
    "/compact",
    ...harness.args,
    "--output-format",
    "stream-json",
    "--verbose",
    "--strict-mcp-config",
    "--setting-sources",
    "user,project",
  ];
  const { done } = spawnClaude(args, dir, () => {}, {
    extraEnv: harness.env,
    timeoutMs: COMPACT_TIMEOUT_MS,
  });
  await done;
  return (await countCompactBoundaries(sessionId, dir)) > before;
}

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
  signal?: AbortSignal,
): AsyncGenerator<Frame, void, unknown> {
  yield ["status", { phase: "queued", detail: "Waiting for a free slot" }];

  let release: (() => void) | undefined;
  let child: ChildProcess | null = null;
  // Stop (cancelJob) aborts the signal → SIGKILL the current child. Killing it
  // resolves spawnClaude's `done`, which closes the frame queue and unblocks the
  // generator so it runs its finally (releasing the site lock) and ends.
  const onAbort = () => {
    try {
      child?.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) return; // stopped before we even started
    release = await acquireSiteLock(site.id);
    if (signal?.aborted) return; // stopped while waiting for this site's checkout

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

    // Per-site harness settings (model / effort / permission mode — see
    // harness.ts). Loaded inside the site lock, once per job.
    const [initialHarness, lastUsage] = await Promise.all([loadHarness(site.id), readLastUsage(site.id)]);
    let harness = initialHarness;
    console.log(
      `[harness] site=${site.id} model=${harness.settings.model ?? "default"} effort=${harness.settings.effort ?? "default"} mode=${harness.settings.permissionMode ?? "bypassPermissions"}${harness.warnings.length ? ` warnings=${harness.warnings.length}` : ""}`,
    );

    // Fresh slate for images the agent shows this turn (see collectOutputs).
    await resetOutputs(site.id).catch(() => {});

    yield ["status", { phase: "starting", detail: "Thinking…" }];

    let result: ClaudeResult | undefined;
    let lastErr = "";
    let recovered = false; // session create↔resume flip is a one-shot
    let harnessFellBack = false; // harness-arg rejection fallback is a one-shot too
    let attempt = 0;
    let maxContext = 0; // max plausible context-tokens total seen this run

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
        streamArgs(prompt, sessionId, resume, site, pushBranch, harness, lastUsage, STREAMING_INPUT),
        dir,
        (e) => {
          if (e.t === "usage") {
            maxContext = Math.max(maxContext, e.contextTokens);
          } else if (e.t === "todos") {
            queue.push(["todos", { items: e.items }]);
          } else if (e.t === "delta") {
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
            // A tool call ends the current assistant message. Clear the live text
            // so the NEXT message streams on its own instead of concatenating into
            // one growing run-on blob. The final reply (no tool after it) is
            // unaffected, and result.reply comes from the CLI's result line anyway.
            streamed = "";
            snapshot = "";
            queue.push(["status", { phase: "tool", detail: e.detail }]);
          }
        },
        { extraEnv: harness.env, ...(STREAMING_INPUT ? { stdin: userMessageLine(prompt) } : {}) },
      );
      child = c;
      const settled = done.finally(() => queue.close());
      for await (const frame of queue) yield frame;
      const out = await settled;
      child = null;
      result = out.result;
      lastErr = out.stderr || (result?.is_error ? String(result?.result ?? "") : "");

      if (signal?.aborted) return; // stopped by the user — end the run, no retry
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

      // Self-persisted-settings recovery: if the CLI rejects an arg the harness
      // produced (e.g. a model id that passed the regex but doesn't exist), a
      // wedged settings file would fail EVERY future turn — the agent can't fix
      // a file it needs a successful turn to edit. Retry once on defaults.
      if (
        !harnessFellBack &&
        !result &&
        harness.args.length &&
        /unknown option|unrecognized|invalid (value|argument|option)|not a valid|no such model/i.test(lastErr)
      ) {
        harnessFellBack = true;
        harness = fallbackHarness(harness.settings); // keeps permissionMode; drops model/effort
        harness.warnings.push("your settings produced CLI args the runtime rejected — this turn ran on the default model; fix your settings file");
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
      let reply = (result.result ?? "").toString().trim();

      // Plan-mode escape hatch: a trailing [[settings: {...}]] line is applied
      // server-side and stripped from the visible reply (see harness.ts). Only
      // honored in the modes where the agent CANNOT edit its own settings file —
      // in bypass/acceptEdits it must edit the file, which keeps this in-band
      // channel from being a general (injectable) settings mutator.
      const lockedMode =
        harness.settings.permissionMode === "plan" || harness.settings.permissionMode === "default";
      if (lockedMode) {
        const { patch, cleaned } = extractReplyDirectives(reply);
        if (patch) {
          reply = cleaned;
          await saveSettings(site.id, patch).catch(() => {});
        }
      }

      // Approximate context bookkeeping — read back by the next turn's harness note.
      let turnUsage: TurnUsage | null = null;
      if (maxContext > 0) {
        turnUsage = {
          contextTokens: maxContext,
          contextPct: Math.min(100, Math.round((maxContext / CONTEXT_WINDOW_TOKENS) * 100)),
          at: new Date().toISOString(),
        };
        await writeLastUsage(site.id, turnUsage).catch(() => {});
      }

      // One-shot on-demand compaction: the agent (or a reply directive) set
      // compactNow in the settings file during this turn. The flag is CONSUMED
      // BEFORE the compact runs — if the clear failed after a run, every future
      // turn would re-compact forever. Verify the boundary landed; report
      // honestly either way.
      const post = await loadHarness(site.id);
      // Skip compaction if we're about to clear — the session is about to be
      // abandoned anyway, so compacting it first is wasted work.
      if (post.settings.compactNow && !post.settings.clearNow) {
        const consumed = await clearCompactFlag(site.id).then(() => true, () => false);
        if (consumed) {
          yield ["status", { phase: "compacting", detail: "Compacting memory" }];
          const ok = await runCompactTurn(sessionId, dir, post).catch(() => false);
          reply = `${reply}\n\n_${ok ? "Memory compacted." : "On-demand compact didn't take — auto-compaction stays active."}_`.trim();
        }
        // clear failed → skip the compact entirely rather than risk re-running
        // it on every future turn off a stuck flag.
      }

      // One-shot context clear: DESTRUCTIVE. Rotate to a fresh conversation so the
      // NEXT turn has no memory and the history reads empty. Consume the flag
      // BEFORE rotating, so a failure can't loop it on every future turn.
      let contextCleared = false;
      if (post.settings.clearNow) {
        const consumed = await saveSettings(site.id, { clearNow: undefined }).then(() => true, () => false);
        if (consumed) {
          contextCleared = await rotateConversation(site.id).then(() => true, () => false);
          if (contextCleared) reply = `${reply}\n\n_Context cleared — fresh session, chat history wiped._`.trim();
        }
      }

      // Any images the agent dropped in .tmp/outputs/ this turn, to show in chat.
      const images = await collectOutputs(site.id).catch(() => []);
      yield [
        "result",
        {
          reply,
          git,
          images,
          cleared: contextCleared,
          usage: {
            cost_usd: result.total_cost_usd ?? null,
            duration_ms: result.duration_ms ?? null,
            context_tokens: turnUsage?.contextTokens ?? lastUsage?.contextTokens ?? null,
            context_pct: turnUsage?.contextPct ?? lastUsage?.contextPct ?? null,
            model: harness.settings.model ?? process.env.CLAUDE_MODEL ?? "opus",
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

/**
 * M2 (behind AK_STREAMING_SESSION): a long-lived streaming session. Unlike
 * runMessageJob (one prompt → one result → exit), the CLI process stays alive
 * with stdin open — the initial turn is written on spawn, follow-ups arrive via
 * the InputChannel (the append endpoint), and EACH turn ends with its own
 * `result` frame while the job stays open. Closes on idle or a hard lifetime cap,
 * then the process exits and the session ends. The checkout syncs ONCE up front,
 * so turns in a session share the working tree (no per-message reset to origin).
 */
export async function* runStreamingSession(
  site: Site,
  opts: { text: string; page: string; attachmentPaths: string[] },
  input: InputChannel,
  signal?: AbortSignal,
): AsyncGenerator<Frame, void, unknown> {
  yield ["status", { phase: "queued", detail: "Waiting for a free slot" }];

  let release: (() => void) | undefined;
  let child: ChildProcess | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  let closeInput = () => {};
  const onAbort = () => {
    try {
      child?.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) return;
    release = await acquireSiteLock(site.id);
    if (signal?.aborted) return;

    yield ["status", { phase: "syncing", detail: `Syncing ${site.domain}` }];
    let turnStartSha = await syncCheckout(site);
    const dir = checkoutPath(site.id);
    const pushBranch = resolvePushBranch(site);
    const conversationId = await conversationIdFor(site.id);
    const sessionId = sessionIdFor(conversationId);
    const marker = markerPathFor(conversationId);
    mkdirSync(CONVERSATIONS_DIR, { recursive: true });
    const resume = existsSync(marker);
    const prompt = buildPrompt(site, opts);
    const [harness, lastUsage] = await Promise.all([loadHarness(site.id), readLastUsage(site.id)]);
    console.log(
      `[harness] site=${site.id} streaming-session model=${harness.settings.model ?? "default"} effort=${harness.settings.effort ?? "default"}`,
    );
    await resetOutputs(site.id).catch(() => {});

    yield ["status", { phase: "starting", detail: "Thinking…" }];

    const queue = new FrameQueue<Frame>();
    let streamed = "";
    let snapshot = "";
    let lastAssistantEmit = 0;
    let thinkingTail = "";
    let lastThinkingEmit = 0;
    let maxContext = 0;
    const best = () => (streamed.length >= snapshot.length ? streamed : snapshot);
    const emitAssistant = () => {
      const now = Date.now();
      if (now - lastAssistantEmit >= ASSISTANT_THROTTLE_MS) {
        lastAssistantEmit = now;
        const text = best();
        if (text) queue.push(["assistant", { text }]);
      }
    };
    const clearIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    const armIdle = () => {
      clearIdle();
      idleTimer = setTimeout(() => {
        queue.push(["status", { phase: "starting", detail: "Session idle — closing" }]);
        closeInput();
      }, SESSION_IDLE_MS);
    };

    // A turn completed: summarize git for THIS turn, emit its result frame, then
    // idle-wait for the next message. Async (git is I/O), but between turns the
    // process stays alive (stdin open), so the queue is still open when it pushes.
    const onResult = (r: ClaudeResult) => {
      clearIdle();
      void (async () => {
        const git = await gitSummary(site, turnStartSha, pushBranch).catch(
          () => ({}) as Awaited<ReturnType<typeof gitSummary>>,
        );
        if (git.headSha) turnStartSha = git.headSha;
        const images = await collectOutputs(site.id).catch(() => []);
        if (maxContext > 0) {
          await writeLastUsage(site.id, {
            contextTokens: maxContext,
            contextPct: Math.min(100, Math.round((maxContext / CONTEXT_WINDOW_TOKENS) * 100)),
            at: new Date().toISOString(),
          }).catch(() => {});
        }
        queue.push([
          "result",
          {
            reply: (r.result ?? "").toString().trim(),
            git,
            images,
            usage: {
              cost_usd: r.total_cost_usd ?? null,
              duration_ms: r.duration_ms ?? null,
              model: harness.settings.model ?? process.env.CLAUDE_MODEL ?? "opus",
            },
            conversation_id: conversationId,
            open: true, // the session stays open for more turns
          },
        ]);
        await writeFile(marker, sessionId).catch(() => {});
        await resetOutputs(site.id).catch(() => {}); // fresh image slate for the next turn
        streamed = "";
        snapshot = "";
        armIdle();
      })();
    };

    const spawned = spawnClaude(
      streamArgs(prompt, sessionId, resume, site, pushBranch, harness, lastUsage, true),
      dir,
      (e) => {
        if (e.t === "usage") maxContext = Math.max(maxContext, e.contextTokens);
        else if (e.t === "todos") queue.push(["todos", { items: e.items }]);
        else if (e.t === "delta") {
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
            queue.push(["status", { phase: "thinking", detail: thinkingTail.split(/\s+/).join(" ").trim().slice(-120) }]);
          }
        } else if (e.t === "tool") {
          streamed = "";
          snapshot = "";
          queue.push(["status", { phase: "tool", detail: e.detail }]);
        } else if (e.t === "result") {
          onResult(e.result);
        }
      },
      { extraEnv: harness.env, stdin: userMessageLine(prompt), keepStdinOpen: true },
    );
    child = spawned.child;
    closeInput = spawned.closeInput;

    // Follow-up turns injected by the append endpoint while the session is live.
    input.attach((text) => {
      clearIdle();
      queue.push(["injected", { text }]);
      void resetOutputs(site.id).catch(() => {});
      spawned.writeInput(userMessageLine(text));
    });

    // Hard lifetime cap: even a continuously-busy session eventually closes so the
    // site lock can never be held forever.
    maxTimer = setTimeout(() => {
      queue.push(["status", { phase: "starting", detail: "Session reached its limit — closing" }]);
      closeInput();
    }, SESSION_MAX_MS);

    const settled = spawned.done.finally(() => queue.close());
    for await (const frame of queue) yield frame;
    const out = await settled;
    if (signal?.aborted) return;
    if (out.stderr && !out.result) {
      yield ["error", { kind: isThrottle(out.stderr) ? "rate_limited" : "agent_failed", detail: out.stderr.slice(0, 500) }];
    }
  } catch (err) {
    yield ["error", { kind: "server_error", detail: String((err as Error)?.message ?? err).slice(0, 500) }];
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (maxTimer) clearTimeout(maxTimer);
    input.close();
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
