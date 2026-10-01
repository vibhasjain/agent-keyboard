// Notes: markdown pages the owner writes in the bar's full-screen editor for
// bigger change requests, then references from a prompt as [[name]]. One .md
// file per note under the checkout's git-excluded `.tmp/notes/`, so the agent
// reads them with a repo-relative path. Turn-start sync never cleans `.tmp`, and
// Restart's `git clean -fdx` excludes `.tmp/notes` (resetCheckoutToOrigin).

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkoutPath } from "./checkouts.js";

export const NOTES_REL = join(".tmp", "notes");

/** A note name is its filename minus `.md`: no path separators, no leading dot
 *  (so no traversal or hidden files), no brackets (they delimit [[mentions]]). */
export function validNoteName(name: unknown): name is string {
  return typeof name === "string" && /^[^./\\[\]\x00-\x1f][^/\\[\]\x00-\x1f]{0,79}$/.test(name) && name.trim() === name;
}

function notePath(siteId: string, name: string): string {
  return join(checkoutPath(siteId), NOTES_REL, `${name}.md`);
}

/** The owner's sidebar layout: note names, and one level of folders holding
 *  note names (a dotfile, so never a note). Notes stay flat on disk — folders
 *  only group them in the sidebar, so a name is unique across folders. */
const orderPath = (siteId: string) => join(checkoutPath(siteId), NOTES_REL, ".order.json");

export type NoteOrder = (string | { folder: string; notes: string[] })[];

export function validOrder(order: unknown): order is NoteOrder {
  return (
    Array.isArray(order) &&
    order.length <= 1000 &&
    order.every(
      (i) =>
        validNoteName(i) ||
        (validNoteName(i?.folder) && Array.isArray(i.notes) && i.notes.length <= 1000 && i.notes.every(validNoteName)),
    )
  );
}

async function readOrder(siteId: string): Promise<NoteOrder> {
  const order: unknown = await readFile(orderPath(siteId), "utf8").then(JSON.parse).catch(() => []);
  return validOrder(order) ? order : [];
}

export async function writeOrder(siteId: string, order: NoteOrder): Promise<void> {
  await mkdir(join(checkoutPath(siteId), NOTES_REL), { recursive: true });
  await writeFile(orderPath(siteId), JSON.stringify(order));
}

/** The saved layout minus deleted notes, plus notes not in it yet (new) at the
 *  end, oldest first. */
export async function noteTree(siteId: string): Promise<NoteOrder> {
  const dir = join(checkoutPath(siteId), NOTES_REL);
  const files = await readdir(dir).catch(() => [] as string[]);
  const notes = await Promise.all(
    files
      .filter((f) => f.endsWith(".md"))
      .map(async (f) => ({ name: f.slice(0, -3), updatedAt: (await stat(join(dir, f))).mtimeMs })),
  );
  const left = new Set(notes.map((n) => n.name));
  const take = (n: string) => left.delete(n);
  const tree = (await readOrder(siteId))
    .map((i) => (typeof i === "string" ? i : { folder: i.folder, notes: i.notes.filter(take) }))
    .filter((i) => typeof i !== "string" || take(i));
  const fresh = notes.filter((n) => left.has(n.name)).sort((a, b) => a.updatedAt - b.updatedAt);
  return [...tree, ...fresh.map((n) => n.name)];
}

/** Every note, flat, in sidebar order (for the composer's #mention list). */
export async function listNotes(siteId: string): Promise<{ name: string; folder?: string }[]> {
  return (await noteTree(siteId)).flatMap((i) =>
    typeof i === "string" ? [{ name: i }] : i.notes.map((name) => ({ name, folder: i.folder })),
  );
}

export async function readNote(siteId: string, name: string): Promise<string | null> {
  return readFile(notePath(siteId, name), "utf8").catch(() => null);
}

/** Write a note; with `from`, rename that note to `name` first. Returns false if
 *  the name is taken: by another note (rename) or by a folder, since folder and
 *  note names are unique together. */
export async function writeNote(siteId: string, name: string, content: string, from?: string): Promise<boolean> {
  await mkdir(join(checkoutPath(siteId), NOTES_REL), { recursive: true });
  const exists = existsSync(notePath(siteId, name));
  if (!exists && (await readOrder(siteId)).some((i) => typeof i !== "string" && i.folder === name)) return false;
  if (from && from !== name) {
    if (exists) return false;
    await rename(notePath(siteId, from), notePath(siteId, name)).catch(() => {});
    const swap = (n: string) => (n === from ? name : n);
    const order = await readOrder(siteId);
    await writeOrder(siteId, order.map((i) => (typeof i === "string" ? swap(i) : { ...i, notes: i.notes.map(swap) })));
  }
  await writeFile(notePath(siteId, name), content);
  return true;
}

export async function deleteNote(siteId: string, name: string): Promise<void> {
  await rm(notePath(siteId, name), { force: true });
}

/** Point the agent at every existing note the prompt mentions as #name or
 *  [[name]], and at the notes those notes mention in turn. */
export function notesNote(siteId: string, text: string): string {
  const names: string[] = [];
  const queue = [text];
  // Names may hold spaces, so #mentions are matched against the existing notes.
  const all = text.includes("#")
    ? (existsSync(join(checkoutPath(siteId), NOTES_REL)) ? readdirSync(join(checkoutPath(siteId), NOTES_REL), { withFileTypes: true }) : [])
        .filter((f) => f.isFile() && f.name.endsWith(".md"))
        .map((f) => f.name.slice(0, -3))
    : [];
  while (queue.length) {
    const t = queue.shift()!;
    const found = [...t.matchAll(/\[\[([^\[\]]+)\]\]/g)].map((m) => m[1]!.trim());
    const lower = t.toLowerCase();
    for (const n of all) if (lower.includes(`#${n.toLowerCase()}`)) found.push(n);
    for (const n of found) {
      if (names.includes(n) || !validNoteName(n) || !existsSync(notePath(siteId, n))) continue;
      names.push(n);
      queue.push(readFileSync(notePath(siteId, n), "utf8"));
    }
  }
  if (!names.length) return "";
  const list = names.map((n) => `[[${n}]] = ${join(NOTES_REL, `${n}.md`)}`).join(", ");
  return `\n\n[Referenced notes — read each in full before acting; the change requested is what they describe: ${list}]`;
}
