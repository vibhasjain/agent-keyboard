// Notes: markdown pages the owner writes in the bar's full-screen editor for
// bigger change requests, then references from a prompt as [[name]]. One .md
// file per note under the checkout's git-excluded `.tmp/notes/`, so the agent
// reads them with a repo-relative path. Turn-start sync never cleans `.tmp`, and
// Restart's `git clean -fdx` excludes `.tmp/notes` (resetCheckoutToOrigin).

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkoutPath } from "./checkouts.js";

export const NOTES_REL = join(".tmp", "notes");
const execFileP = promisify(execFile);

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

/** The default folder for yyyy-mm-dd notes (the editor's Today button). */
export const DAILY_FOLDER = "Daily notes";
const isDaily = (n: string) => /^\d{4}-\d{2}-\d{2}$/.test(n);
/** A fixed folder for retired notes: they stay readable but can't be #mentioned. */
export const ARCHIVE_FOLDER = "Archive";

/** The saved layout minus deleted notes, plus notes not in it yet (new) at the
 *  end, oldest first. A Daily notes folder always exists (unless a note has its
 *  name); it takes in new yyyy-mm-dd notes and lists dates newest first. An
 *  Archive folder always exists the same way. */
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
  const fresh = notes.filter((n) => left.has(n.name)).sort((a, b) => a.updatedAt - b.updatedAt).map((n) => n.name);
  let daily = tree.find((i) => typeof i !== "string" && i.folder === DAILY_FOLDER) as { folder: string; notes: string[] } | undefined;
  if (!daily && !notes.some((n) => n.name === DAILY_FOLDER)) tree.push((daily = { folder: DAILY_FOLDER, notes: [] }));
  if (daily) {
    daily.notes.push(...fresh.filter(isDaily));
    // Stable: dates first, newest on top; anything else keeps its order below.
    daily.notes.sort((a, b) => +isDaily(b) - +isDaily(a) || (isDaily(a) && isDaily(b) ? b.localeCompare(a) : 0));
  }
  if (!tree.some((i) => typeof i !== "string" && i.folder === ARCHIVE_FOLDER) && !notes.some((n) => n.name === ARCHIVE_FOLDER))
    tree.push({ folder: ARCHIVE_FOLDER, notes: [] });
  return [...tree, ...fresh.filter((n) => !daily || !isDaily(n))];
}

/** Every note but the archived ones, flat, in sidebar order (for the composer's #mention list). */
export async function listNotes(siteId: string): Promise<{ name: string; folder?: string }[]> {
  return (await noteTree(siteId)).flatMap((i) =>
    typeof i === "string" ? [{ name: i }] : i.folder === ARCHIVE_FOLDER ? [] : i.notes.map((name) => ({ name, folder: i.folder })),
  );
}

export async function readNote(siteId: string, name: string): Promise<string | null> {
  return readFile(notePath(siteId, name), "utf8").catch(() => null);
}

/** Blame, in a sidecar so notes stay plain markdown: who created each note and
 *  who edited it, most recent first. Agent edits bypass this (they write the
 *  file directly); the editor infers them from an mtime newer than the last
 *  recorded edit. */
const metaPath = (siteId: string) => join(checkoutPath(siteId), NOTES_REL, ".meta.json");

export type NoteMeta = { createdBy: string; createdAt: string; editors: { email: string; at: string }[] };

async function readMeta(siteId: string): Promise<Record<string, NoteMeta>> {
  const meta: unknown = await readFile(metaPath(siteId), "utf8").then(JSON.parse).catch(() => ({}));
  return meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, NoteMeta>) : {};
}

async function updateMeta(siteId: string, fn: (meta: Record<string, NoteMeta>) => void): Promise<void> {
  const meta = await readMeta(siteId);
  fn(meta);
  await writeFile(metaPath(siteId), JSON.stringify(meta));
}

/** A note's blame plus its file mtime (ms), or null if unknown. */
export async function noteMeta(siteId: string, name: string): Promise<(Partial<NoteMeta> & { updatedAt: number }) | null> {
  const st = await stat(notePath(siteId, name)).catch(() => null);
  return st && { ...(await readMeta(siteId))[name], updatedAt: st.mtimeMs };
}

/** Write a note; with `from`, rename that note to `name` first. Returns false if
 *  the name is taken: by another note (rename) or by a folder, since folder and
 *  note names are unique together. */
export async function writeNote(siteId: string, name: string, content: string, from?: string, by?: string): Promise<boolean> {
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
  await updateMeta(siteId, (meta) => {
    if (from && from !== name && meta[from]) {
      meta[name] = meta[from];
      delete meta[from];
    }
    if (!by) return;
    const at = new Date().toISOString();
    const m = (meta[name] ??= { createdBy: by, createdAt: at, editors: [] });
    m.editors = [{ email: by, at }, ...m.editors.filter((e) => e.email !== by)];
  });
  return true;
}

export async function deleteNote(siteId: string, name: string): Promise<void> {
  await rm(notePath(siteId, name), { force: true });
  await updateMeta(siteId, (meta) => delete meta[name]);
}

/** Point the agent at every existing note the prompt mentions as #name or
 *  [[name]], and at the notes those notes mention in turn. Mentioning a folder
 *  mentions every note in it. */
export function notesNote(siteId: string, text: string): string {
  const names: string[] = [];
  const queue = [text];
  // Names may hold spaces, so #mentions are matched against the existing notes.
  const all = text.includes("#")
    ? (existsSync(join(checkoutPath(siteId), NOTES_REL)) ? readdirSync(join(checkoutPath(siteId), NOTES_REL), { withFileTypes: true }) : [])
        .filter((f) => f.isFile() && f.name.endsWith(".md"))
        .map((f) => f.name.slice(0, -3))
    : [];
  let folders: Map<string, string[]>;
  try {
    const order: unknown = JSON.parse(readFileSync(orderPath(siteId), "utf8"));
    folders = new Map(validOrder(order) ? order.flatMap((i) => (typeof i === "string" ? [] : [[i.folder, i.notes] as const])) : []);
  } catch {
    folders = new Map();
  }
  // Archived notes (and the Archive folder) can't be #mentioned; [[links]] to them still resolve.
  const archived = new Set([ARCHIVE_FOLDER, ...(folders.get(ARCHIVE_FOLDER) ?? [])]);
  folders.delete(ARCHIVE_FOLDER);
  if (all.length) all.push(...folders.keys());
  while (queue.length) {
    const t = queue.shift()!;
    const found = [...t.matchAll(/\[\[([^\[\]]+)\]\]/g)].map((m) => m[1]!.trim());
    const lower = t.toLowerCase();
    for (const n of all) if (!archived.has(n) && lower.includes(`#${n.toLowerCase()}`)) found.push(n);
    for (const n of [...found]) found.push(...(folders.get(n) ?? []));
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

/** Where a sandbox keeps the notes it started from (a dot dir, so never a note
 *  and kept by Restart), for the 3-way merge on publish. */
export const NOTES_BASE = ".base";

/** Merge a published sandbox's notes into live, against the snapshot the
 *  sandbox started from: notes only the sandbox changed are copied, ones only it
 *  deleted are deleted, ones both changed go through `git merge-file`. Daily
 *  notes are scratch and skipped. On a conflict live's file is kept. Without a
 *  snapshot (older sandboxes) only notes new to live are copied and any other
 *  difference is a conflict. Returns the conflicting note names. */
export async function mergeNotes(fromId: string, toId: string): Promise<string[]> {
  const src = join(checkoutPath(fromId), NOTES_REL);
  const dst = join(checkoutPath(toId), NOTES_REL);
  const baseDir = join(src, NOTES_BASE);
  const hasBase = existsSync(baseDir);
  const read = (dir: string, n: string) => readFile(join(dir, `${n}.md`), "utf8").catch(() => null);
  const names = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
  const all = [...new Set([...(await names(src)), ...(await names(baseDir))])].filter((n) => validNoteName(n) && !isDaily(n));
  const conflicts: string[] = [];
  const written: string[] = [];
  const deleted: string[] = [];
  await mkdir(dst, { recursive: true });
  for (const n of all) {
    const [s, b, l] = [await read(src, n), hasBase ? await read(baseDir, n) : null, await read(dst, n)];
    if (s === l || (hasBase && s === b)) continue; // nothing new from the sandbox
    if (!hasBase) {
      if (l === null) written.push(n);
      else conflicts.push(n);
    } else if (s === null) {
      if (l === b) deleted.push(n); // deleted in the sandbox only; else live changed it, keep it
    } else if (l === b) written.push(n);
    else if (b === null || l === null) conflicts.push(n); // added on both sides, or live deleted it
    else {
      const tmp = join(dst, `.merge-${process.pid}`);
      await mkdir(tmp, { recursive: true });
      await Promise.all([writeFile(join(tmp, "l"), l), writeFile(join(tmp, "b"), b), writeFile(join(tmp, "s"), s)]);
      const clean = await execFileP("git", ["merge-file", "-p", "l", "b", "s"], { cwd: tmp }).then(
        (r) => r.stdout,
        () => null, // exit >0: conflicts
      );
      await rm(tmp, { recursive: true, force: true });
      if (clean === null) conflicts.push(n);
      else await writeFile(join(dst, `${n}.md`), clean);
    }
  }
  for (const n of written) await writeFile(join(dst, `${n}.md`), (await read(src, n))!);
  for (const n of deleted) await rm(join(dst, `${n}.md`), { force: true });

  // Sidebar: live's order, minus deleted notes, plus new notes in the sandbox's folder for them.
  const json = (p: string, d: unknown) => readFile(p, "utf8").then(JSON.parse).catch(() => d);
  const srcOrder: unknown = await json(join(src, ".order.json"), []);
  const dstOrder: unknown = await json(join(dst, ".order.json"), []);
  const order: NoteOrder = (validOrder(dstOrder) ? dstOrder : [])
    .filter((i) => typeof i !== "string" || !deleted.includes(i))
    .map((i) => (typeof i === "string" ? i : { folder: i.folder, notes: i.notes.filter((x) => !deleted.includes(x)) }));
  const inOrder = new Set(order.flatMap((i) => (typeof i === "string" ? [i] : i.notes)));
  for (const n of written.filter((x) => !inOrder.has(x))) {
    const folder = (validOrder(srcOrder) ? srcOrder : []).find((i) => typeof i !== "string" && i.notes.includes(n)) as { folder: string } | undefined;
    if (!folder) order.push(n);
    else {
      const f = order.find((i) => typeof i !== "string" && i.folder === folder.folder) as { folder: string; notes: string[] } | undefined;
      if (f) f.notes.push(n);
      else order.push({ folder: folder.folder, notes: [n] });
    }
  }
  await writeFile(join(dst, ".order.json"), JSON.stringify(order));

  // Blame: the sandbox's record for notes it wrote, none for notes it deleted.
  const srcMeta = (await json(join(src, ".meta.json"), {})) as Record<string, NoteMeta>;
  const dstMeta = (await json(join(dst, ".meta.json"), {})) as Record<string, NoteMeta>;
  for (const n of written) if (srcMeta[n]) dstMeta[n] = srcMeta[n];
  for (const n of deleted) delete dstMeta[n];
  await writeFile(join(dst, ".meta.json"), JSON.stringify(dstMeta));
  return conflicts;
}
