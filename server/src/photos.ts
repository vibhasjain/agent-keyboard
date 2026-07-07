// Attachment staging for the prompt bar. Camera/photo uploads are normalized
// with sharp (rotate -> resize <=1568px -> JPEG q85, Claude's effective vision
// cap). Other files are written as-is. Everything lives under the site checkout's
// `.tmp/uploads/` dir so the agent can Read it with a repo-relative path.
//
// Uploads live under .git/info/exclude'd `.tmp/`, so they never get committed.
// A boot sweep purges anything older than 24h across all checkouts.

import { mkdir, writeFile, readdir, stat, rm, rename } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { checkoutPath } from "./checkouts.js";

const MAX_DIM = 1568;
const UPLOAD_TTL_MS = 24 * 60 * 60_000;

// Agent-produced images (things the agent wants to SHOW the user) live in a
// sibling dir. Same .tmp/ tree, so they're git-excluded and swept the same way.
const OUTPUT_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;
const SERVED_NAME_RE = /^[a-f0-9-]{36}\.(png|jpe?g|gif|webp)$/i;
const MAX_OUTPUT_BYTES = 15 * 1024 * 1024;
const MAX_OUTPUTS = 6;

export interface StagedPhoto {
  id: string;
  path: string; // repo-relative, e.g. ".tmp/uploads/<uuid>.jpg"
  absPath: string;
  kind: "photo" | "file";
  name: string;
  size: number;
  mime?: string;
}

function uploadsDir(siteId: string): string {
  return join(checkoutPath(siteId), ".tmp", "uploads");
}

/** Normalize + write one uploaded image into a site's staging dir. */
export async function stageUpload(siteId: string, input: Buffer): Promise<StagedPhoto> {
  const sharp = (await import("sharp")).default;
  const dir = uploadsDir(siteId);
  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  const absPath = join(dir, `${id}.jpg`);
  const jpeg = await sharp(input)
    .rotate()
    .resize({ width: MAX_DIM, height: MAX_DIM, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  await writeFile(absPath, jpeg);
  return {
    id,
    path: relative(checkoutPath(siteId), absPath),
    absPath,
    kind: "photo",
    name: "photo.jpg",
    size: jpeg.length,
    mime: "image/jpeg",
  };
}

function safeFileName(name: string): string {
  const base = basename(name || "attachment").replace(/[^\w.\-()+ ]+/g, "_").replace(/\s+/g, "_");
  const trimmed = base.replace(/^_+|_+$/g, "").slice(0, 96);
  return trimmed || "attachment";
}

/** Write one arbitrary uploaded file into a site's staging dir. */
export async function stageFileUpload(
  siteId: string,
  input: Buffer,
  filename: string,
  mime?: string,
): Promise<StagedPhoto> {
  const dir = uploadsDir(siteId);
  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  const name = safeFileName(filename);
  const absPath = join(dir, `${id}-${name}`);
  await writeFile(absPath, input);
  return {
    id,
    path: relative(checkoutPath(siteId), absPath),
    absPath,
    kind: "file",
    name,
    size: input.length,
    mime,
  };
}

/**
 * Resolve upload ids (from POST /messages) to their repo-relative paths for the
 * given site. Silently drops ids whose staged file is gone (expired / never
 * existed) — a missing attachment shouldn't sink the whole message.
 */
export async function resolveAttachments(siteId: string, ids: string[]): Promise<string[]> {
  const dir = uploadsDir(siteId);
  const out: string[] = [];
  let files: string[] | null = null;
  for (const rawId of ids) {
    const id = String(rawId).replace(/[^a-fA-F0-9-]/g, ""); // never let an id escape the dir
    if (!id) continue;
    const abs = join(dir, `${id}.jpg`);
    try {
      await stat(abs);
      out.push(relative(checkoutPath(siteId), abs));
      continue;
    } catch {
      /* may be a generic file staged as <id>-<safeName> */
    }
    try {
      files ??= await readdir(dir);
      const name = files.find((f) => f.startsWith(`${id}-`));
      if (!name) continue;
      const fileAbs = join(dir, name);
      const s = await stat(fileAbs);
      if (s.isFile()) out.push(relative(checkoutPath(siteId), fileAbs));
    } catch {
      /* expired or unknown id */
    }
  }
  return out;
}

/** Delete specific staged uploads (repo-relative paths) for a site (post-job cleanup). */
export async function cleanupUploads(siteId: string, relPaths: string[]): Promise<void> {
  const base = checkoutPath(siteId);
  await Promise.all(
    relPaths.map((p) => rm(join(base, p), { force: true }).catch(() => {})),
  );
}

/** Boot sweep: purge staged uploads + agent outputs older than 24h everywhere. */
export async function purgeStaleUploads(siteIds: string[]): Promise<void> {
  const now = Date.now();
  for (const siteId of siteIds) {
    for (const dir of [uploadsDir(siteId), outputsDir(siteId)]) {
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        continue; // dir may not exist yet
      }
      for (const f of files) {
        const abs = join(dir, f);
        try {
          const s = await stat(abs);
          if (now - s.mtimeMs > UPLOAD_TTL_MS) await rm(abs, { force: true });
        } catch {
          /* gone */
        }
      }
    }
  }
}

// ── agent-produced images (assistant → user, shown in the chat) ──────────────

function outputsDir(siteId: string): string {
  return join(checkoutPath(siteId), ".tmp", "outputs");
}

export interface OutputImage {
  name: string; // served filename, e.g. "<uuid>.png"
  alt: string; // the agent's original filename (sans extension), as a caption
}

/** Clear a site's outputs dir at the start of a turn, so we only ever surface
 *  images the agent produced THIS turn (clean attribution, bounded growth). */
export async function resetOutputs(siteId: string): Promise<void> {
  await rm(outputsDir(siteId), { recursive: true, force: true }).catch(() => {});
}

/** Collect the images the agent left in `.tmp/outputs/` this turn. Each is
 *  renamed to an unguessable `<uuid>.<ext>` (so the open asset route can serve
 *  it without leaking a guessable path) and returned for the result frame. */
export async function collectOutputs(siteId: string): Promise<OutputImage[]> {
  const dir = outputsDir(siteId);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return []; // no outputs dir → the agent produced nothing to show
  }
  const out: OutputImage[] = [];
  for (const f of files.sort()) {
    if (out.length >= MAX_OUTPUTS) break;
    const m = f.match(OUTPUT_EXT_RE);
    if (!m) continue;
    if (SERVED_NAME_RE.test(f)) continue; // already collected (defensive)
    const abs = join(dir, f);
    try {
      const s = await stat(abs);
      if (!s.isFile() || s.size === 0 || s.size > MAX_OUTPUT_BYTES) continue;
    } catch {
      continue;
    }
    const served = `${randomUUID()}${m[0].toLowerCase()}`;
    try {
      await rename(abs, join(dir, served));
    } catch {
      continue;
    }
    out.push({ name: served, alt: f.replace(OUTPUT_EXT_RE, "") });
  }
  return out;
}

/** Validate a served asset name and return its absolute path (or null). The
 *  strict uuid+ext pattern is what keeps the open route from path-traversing. */
export function outputPath(siteId: string, name: string): string | null {
  if (!SERVED_NAME_RE.test(name)) return null;
  return join(outputsDir(siteId), name);
}
