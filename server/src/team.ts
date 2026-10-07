// Teammate notes: a composer message that @mentions someone else with access to
// the site is stored next to the conversation (no Claude turn). Emailing them is
// opt-in per message (the composer's "Email them" toggle; off by default).
// readConversation merges these into the transcript by time.
// One JSONL per conversation, so a Restart (fresh conversation) starts clean.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DATA_DIR, writeDataFile } from "./checkouts.js";
import { sessionIdFor, spawnEnv } from "./claude.js";
import type { ChatMessage } from "./conversation.js";
import type { Site } from "./config.js";

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

// ─── emailed mentions (opt-in) ───────────────────────────────────────────────
// Each email's button goes through /n/<id> (index.ts), which counts a click only
// once the page's script runs — link scanners don't run JS — and tells the sender
// on the first one. Notices live in one JSON file on the volume.

interface Notice {
  id: string;
  from: string;
  to: string;
  url: string;
  sentAt: string;
  clickedAt?: string;
}

const NOTICES = "agent-keyboard/notifications.json";
const notices = new Map<string, Notice>(
  (() => {
    try {
      return (JSON.parse(readFileSync(join(DATA_DIR, NOTICES), "utf8")) as Notice[]).map((n) => [n.id, n] as const);
    } catch {
      return [];
    }
  })(),
);
const saveNotices = () => writeDataFile(NOTICES, JSON.stringify([...notices.values()], null, 1));

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const who = (m: ChatMessage) => (m.role === "assistant" ? "Agent" : m.sender ? handleOf(m.sender) : "Owner");

/** The ask + a short summary, from one quick Haiku run; null if it fails or is slow. */
async function summarize(site: Site, excerpt: ChatMessage[], note: string): Promise<{ ask: string; summary: string } | null> {
  const transcript = [...excerpt.map((m) => `${who(m)}: ${clip(m.text, 1500)}`), `[the mention] ${note}`].join("\n\n");
  const system =
    'Someone @mentioned a teammate in a chat with a coding agent. Reply with JSON only: {"ask": what the mentioned person is asked to do, as a short imperative (several items separated by "; "), or "FYI" if nothing, "summary": a 2-3 sentence summary of the context}';
  return new Promise((resolve) => {
    const child = execFile(
      process.env.CLAUDE_BIN ?? "claude",
      ["-p", "--model", "haiku", "--tools", "", "--no-session-persistence", "--setting-sources", "", "--system-prompt", system],
      { cwd: tmpdir(), env: spawnEnv(site), timeout: 25_000 },
      (err, stdout) => {
        try {
          const j = JSON.parse(err ? "" : /\{[\s\S]*\}/.exec(stdout)?.[0] ?? "") as { ask?: unknown; summary?: unknown };
          resolve(typeof j.ask === "string" && typeof j.summary === "string" ? { ask: j.ask, summary: j.summary } : null);
        } catch {
          resolve(null);
        }
      },
    );
    child.stdin?.end(transcript);
  });
}

async function sendEmail(to: string, subject: string, html: string, text: string, replyTo?: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not set");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || "Agent Keyboard <invites@agentkeyboard.com>",
      to: [to],
      ...(replyTo ? { reply_to: replyTo } : {}),
      subject,
      text,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** The brand's dark card (see email-templates/invite.html), with an optional amber button. */
function card(body: string, cta?: { href: string; label: string }): string {
  const sans = "font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;";
  const button = cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:26px"><tr><td bgcolor="#ffb86b" style="background-color:#ffb86b;border-radius:10px;"><a href="${esc(cta.href)}" style="display:inline-block;padding:13px 26px;${sans}font-size:15px;font-weight:600;line-height:1;color:#141310 !important;text-decoration:none;border-radius:10px;">${esc(cta.label)} &rarr;</a></td></tr></table>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="dark"></head><body style="margin:0;padding:0;background-color:#0a0a0a;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0a0a0a;"><tr><td align="center" style="padding:36px 16px 48px;"><table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;width:100%;"><tr><td align="center" style="padding:0 0 22px;"><img src="https://agentkeyboard.com/typewriter-mark.png" width="66" height="36" alt="Agent Keyboard" style="display:block;margin:0 auto;border:0;"></td></tr><tr><td style="background-color:#111110;border:1px solid #211f1c;border-radius:14px;padding:30px 28px;${sans}font-size:15px;line-height:1.6;color:#b8b2a7;">${body}${button}</td></tr></table></td></tr></table></body></html>`;
}

/** Email each recipient about a mention: the ask, a summary, the last few
 *  messages, and a tracked button back to the chat. Throws if any send fails. */
export async function emailMention(opts: {
  site: Site;
  from: string;
  to: string[];
  text: string;
  url: string;
  excerpt: ChatMessage[];
  publicUrl: string;
}): Promise<void> {
  const { site, from, to, text, url, excerpt } = opts;
  const host = new URL(url).host;
  const s = await summarize(site, excerpt, text);
  const label = "color:#6f6a61;font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;padding:0 0 6px;";
  const ask = s ? (s.ask.trim().toUpperCase() === "FYI" ? "Just an FYI, nothing to do." : s.ask) : null;
  const lines = [...excerpt.map((m) => ({ who: who(m), text: clip(m.text, 600) })), { who: handleOf(from), text }];
  const body =
    `<div style="font-size:20px;line-height:1.35;color:#f5f1ea;padding-bottom:18px;"><span style="color:#ffb86b;">${esc(handleOf(from))}</span> mentioned you on ${esc(host)}</div>` +
    (ask ? `<div style="${label}">The ask</div><div style="color:#f5f1ea;padding-bottom:18px;">${esc(ask)}</div>` : "") +
    (s ? `<div style="${label}">Context</div><div style="padding-bottom:18px;">${esc(s.summary)}</div>` : "") +
    `<div style="${label}">The conversation</div>` +
    lines
      .map(
        (l) =>
          `<div style="border-left:2px solid #211f1c;padding:2px 0 2px 12px;margin:0 0 10px;font-size:13.5px;"><span style="color:#e7d3b8;">${esc(l.who)}</span><br><span style="white-space:pre-wrap;">${esc(l.text)}</span></div>`,
      )
      .join("");
  const plain = [ask && `The ask: ${ask}`, s && `Context: ${s.summary}`, ...lines.map((l) => `${l.who}: ${l.text}`)].filter(Boolean).join("\n\n");
  for (const email of to) {
    const notice: Notice = { id: randomUUID(), from, to: email, url, sentAt: new Date().toISOString() };
    const link = `${opts.publicUrl}/n/${notice.id}`;
    await sendEmail(
      email,
      `${handleOf(from)} mentioned you on ${host}`,
      card(body, { href: link, label: "Open the chat" }),
      `${plain}\n\nOpen the chat: ${link}`,
      from,
    );
    notices.set(notice.id, notice);
  }
  await saveNotices();
}

/** A notice's destination, for the /n/<id> landing page. */
export const noticeUrl = (id: string) => notices.get(id)?.url;

/** Record a real click; on the first one, tell the sender. */
export async function markClicked(id: string): Promise<void> {
  const n = notices.get(id);
  if (!n || n.clickedAt) return;
  n.clickedAt = new Date().toISOString();
  await saveNotices();
  const host = new URL(n.url).host;
  await sendEmail(
    n.from,
    `${handleOf(n.to)} opened your mention on ${host}`,
    card(
      `<div style="font-size:20px;line-height:1.35;color:#f5f1ea;"><span style="color:#ffb86b;">${esc(n.to)}</span> opened the chat you mentioned them in on ${esc(host)}.</div>`,
      { href: n.url, label: "Go to the chat" },
    ),
    `${n.to} opened the chat you mentioned them in: ${n.url}`,
  );
}
