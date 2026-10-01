// Teammate notes: a composer message that @mentions someone else with access to
// the site is stored next to the conversation (no Claude turn) and emailed to
// them via Resend. readConversation merges these into the transcript by time.
// One JSONL per conversation, so a Restart (fresh conversation) starts clean.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./checkouts.js";
import { sessionIdFor } from "./claude.js";
import type { ChatMessage } from "./conversation.js";

/** The @handle for an email: its local part. */
export const handleOf = (email: string) => email.split("@")[0]!.toLowerCase();

const fileFor = (siteId: string, conversationId: string) =>
  join(DATA_DIR, "agent-keyboard", "sites", siteId, "team", `${sessionIdFor(conversationId)}.jsonl`);

export async function readTeamNotes(siteId: string, conversationId: string): Promise<ChatMessage[]> {
  const raw = await readFile(fileFor(siteId, conversationId), "utf8").catch(() => "");
  return raw.split("\n").flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l) as ChatMessage] : [];
    } catch {
      return [];
    }
  });
}

export async function addTeamNote(siteId: string, conversationId: string, msg: ChatMessage): Promise<void> {
  const path = fileFor(siteId, conversationId);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(msg) + "\n", "utf8");
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Email the note to each recipient. Throws on a Resend failure. */
export async function emailTeamNote(to: string[], from: string, text: string, url: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not set");
  const host = new URL(url).host;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || "Agent Keyboard <invites@agentkeyboard.com>",
      to,
      reply_to: from,
      subject: `${from} left you a note on ${host}`,
      text: `${text}\n\n— ${from}, on ${url}`,
      html:
        `<div style="font-family:Inter,system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">` +
        `<p style="white-space:pre-wrap">${esc(text)}</p>` +
        `<p style="color:#6f6a61">— ${esc(from)}, on <a href="${esc(url)}">${esc(host)}</a></p></div>`,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
