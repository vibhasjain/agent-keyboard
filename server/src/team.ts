// Teammate notes: a composer message that @mentions someone else with access to
// the site is stored next to the conversation (no Claude turn; no email, the owner
// turned that off). readConversation merges these into the transcript by time.
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
