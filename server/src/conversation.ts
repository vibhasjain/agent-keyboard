// Reads a site's durable Claude Code session JSONL (the agent's own memory on
// the Fly volume) and normalizes it into chat bubbles for the widget's history
// view. The session file IS the source of truth — "recent + auto-compacted",
// exactly what the agent remembers. Keyed off the per-site checkout cwd slug,
// and strips Agent Keyboard's prompt boilerplate.

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sessionIdFor, conversationIdFor, CLAUDE_HOME } from "./claude.js";
import { checkoutPath } from "./checkouts.js";
import { toolLabel } from "./tool-label.js";

export type ChatPart = { type: "text"; text: string } | { type: "tools"; tools: string[] };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  tools: string[];
  // Ordered assistant content. `text` + `tools` stay above for older widgets;
  // this preserves tool → text → tool boundaries for current ones.
  parts?: ChatPart[];
  ts: string | null;
  // Only set on system dividers (e.g. "compact") so the widget can render them
  // specially; user/assistant messages omit it.
  kind?: "compact";
  // Count of attachments that were attached to a user turn (files are gone; count survives).
  attachments?: number;
  // Back-compat for older turns injected with "Photo(s) attached".
  photos?: number;
  // Who typed a user turn (parsed from the "[Sent from … by <email>]" header);
  // absent on turns from before sender tagging shipped.
  sender?: string;
}

/** Claude Code slugs a project dir as its absolute cwd with `/` and `.` → `-`. */
function slugForCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/** Locate the session JSONL, robust to the project-dir slug. */
export async function sessionFilePath(sessionId: string, cwd: string): Promise<string | null> {
  const projectsDir = join(CLAUDE_HOME, ".claude", "projects");
  // Fast path: the known cwd slug for this checkout.
  const direct = join(projectsDir, slugForCwd(cwd), `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  // Fallback: scan every project dir (handles a different cwd slug).
  try {
    for (const dir of await readdir(projectsDir)) {
      const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* projects dir missing / no match */
  }
  return null;
}

/**
 * Strip the context + attachment boilerplate we inject, so the user bubble is
 * clean. Returns the count from the stripped boilerplate so the widget can show
 * a marker (the staged files themselves are deleted after the job).
 */
export function cleanUserText(raw: string): { text: string; attachments: number; photos: number; sender?: string } {
  let attachments = 0;
  let photos = 0;
  let sender: string | undefined;
  const text = raw
    .split("\n")
    .filter((l) => {
      if (/^Attachment\(s\) attached( — use the Read tool[^:]*)?:/i.test(l)) {
        attachments += (l.match(/\.tmp\//g) ?? []).length || 1;
        return false;
      }
      if (/^Photo\(s\) attached( — use the Read tool[^:]*)?:/i.test(l)) {
        photos += (l.match(/\.tmp\//g) ?? []).length || 1;
        return false;
      }
      const sent = /^\[Sent from \S+(?: by (\S+))?\]$/i.exec(l);
      if (sent) {
        if (sent[1]) sender = sent[1];
        return false;
      }
      return !/^\[Sent from /i.test(l);
    })
    .join("\n")
    .trim();
  return { text, attachments, photos, ...(sender ? { sender } : {}) };
}

function userText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (Array.isArray(content)) {
    // A synthetic tool-result turn has tool_result blocks and no human text → skip.
    if (content.some((b: any) => b?.type === "tool_result")) return null;
    const t = content
      .filter((b: any) => b?.type === "text")
      .map((b: any) => String(b.text ?? ""))
      .join("")
      .trim();
    return t || null;
  }
  return null;
}

function pushPart(parts: ChatPart[], part: ChatPart, textSeparator = ""): void {
  const prev = parts[parts.length - 1];
  if (prev?.type === "text" && part.type === "text") {
    prev.text += textSeparator + part.text;
  } else if (prev?.type === "tools" && part.type === "tools") {
    prev.tools.push(...part.tools);
  } else {
    parts.push(part.type === "text" ? { ...part } : { type: "tools", tools: [...part.tools] });
  }
}

function assistantParts(content: any[], checkoutRoot: string): ChatPart[] {
  const parts: ChatPart[] = [];
  for (const block of content) {
    if (block?.type === "text") {
      const text = String(block.text ?? "");
      if (text.trim()) pushPart(parts, { type: "text", text });
    } else if (block?.type === "tool_use") {
      pushPart(parts, { type: "tools", tools: [toolLabel(block, checkoutRoot)] });
    }
  }
  for (const part of parts) if (part.type === "text") part.text = part.text.trim();
  return parts;
}

/** Normalize one durable session JSONL into ordered transcript messages. */
export function parseConversation(raw: string, checkoutRoot: string): ChatMessage[] {
  const all: ChatMessage[] = [];
  let idx = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const ts = o.timestamp ?? null;
    if (o.type === "user") {
      // isMeta turns are injected, not typed: skill-launch docs ("Base directory
      // for this skill: ...") and poller nudges ("Continue from where you left
      // off."). Never genuine dialogue — skip the whole turn.
      if (o.isMeta) {
        idx++;
        continue;
      }
      const text = userText(o.message?.content);
      if (text) {
        const clean = cleanUserText(text);
        if (clean.text || clean.attachments || clean.photos)
          all.push({
            id: o.uuid ?? `u${idx}`,
            role: "user",
            text: clean.text,
            ...(clean.attachments ? { attachments: clean.attachments } : {}),
            ...(clean.photos ? { photos: clean.photos } : {}),
            ...(clean.sender ? { sender: clean.sender } : {}),
            ts,
            tools: [],
          });
      }
    } else if (o.type === "assistant") {
      const content = o.message?.content;
      if (!Array.isArray(content)) {
        idx++;
        continue;
      }
      const parts = assistantParts(content, checkoutRoot);
      const text = content
        .filter((block: any) => block?.type === "text")
        .map((block: any) => String(block.text ?? ""))
        .join("")
        .trim();
      const tools = parts.flatMap((part) => (part.type === "tools" ? part.tools : []));
      if (!parts.length) {
        idx++;
        continue;
      }
      // Coalesce one assistant turn without throwing away tool/text order.
      const prev = all[all.length - 1];
      if (prev && prev.role === "assistant") {
        prev.text = [prev.text, text].filter(Boolean).join("\n\n");
        prev.tools.push(...tools);
        for (const part of parts) pushPart(prev.parts ??= [], part, "\n\n");
        prev.ts = ts ?? prev.ts;
      } else {
        all.push({ id: o.uuid ?? `a${idx}`, role: "assistant", text, tools, parts, ts });
      }
    } else if (o.type === "system" && o.subtype === "compact_boundary") {
      // Expose the compaction boundary — the widget renders it as a divider.
      all.push({ id: o.uuid ?? `s${idx}`, role: "system", kind: "compact", text: "Session compacted", tools: [], ts });
    }
    idx++;
  }
  return all;
}

/**
 * Parse the session into normalized chat messages, oldest→newest. Returns the
 * newest `limit` messages plus a `cursor` (count of older messages not yet
 * returned) for scroll-to-top lazy loading. `before` = how many newest messages
 * to skip (the cursor handed back last time), so paging walks backward.
 */
export async function readConversation(
  siteId: string,
  opts: { limit?: number; before?: number; pageSlug?: string } = {},
): Promise<{ messages: ChatMessage[]; cursor: number }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 40, 200));
  const before = Math.max(0, opts.before ?? 0);

  const conversationId = await conversationIdFor(siteId, opts.pageSlug ?? "");
  const sessionId = sessionIdFor(conversationId);
  const checkoutRoot = checkoutPath(siteId);
  const path = await sessionFilePath(sessionId, checkoutRoot);
  if (!path) return { messages: [], cursor: 0 };

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { messages: [], cursor: 0 };
  }

  const all = parseConversation(raw, checkoutRoot);

  // Newest-last array. Page from the end: skip `before` newest, take `limit`.
  const end = all.length - before;
  const start = Math.max(0, end - limit);
  const messages = all.slice(start, Math.max(start, end));
  const cursor = start; // number of older messages still available
  return { messages, cursor };
}
