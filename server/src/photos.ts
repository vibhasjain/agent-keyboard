// Photo staging for the prompt bar. An uploaded image is normalized with sharp
// (rotate → resize ≤1568px → JPEG q85 — Claude's effective vision cap) and
// written under the site checkout's `.tmp/uploads/` dir, so the agent can Read
// it with a repo-relative path.
//
// Uploads live under .git/info/exclude'd `.tmp/`, so they never get committed.
// A boot sweep purges anything older than 24h across all checkouts.

import { mkdir, writeFile, readdir, stat, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { checkoutPath } from "./checkouts.js";

const MAX_DIM = 1568;
const UPLOAD_TTL_MS = 24 * 60 * 60_000;

export interface StagedPhoto {
  id: string;
  path: string; // repo-relative, e.g. ".tmp/uploads/<uuid>.jpg"
  absPath: string;
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
  return { id, path: relative(checkoutPath(siteId), absPath), absPath };
}

/**
 * Resolve upload ids (from POST /messages) to their repo-relative paths for the
 * given site. Silently drops ids whose staged file is gone (expired / never
 * existed) — a missing photo shouldn't sink the whole message.
 */
export async function resolveAttachments(siteId: string, ids: string[]): Promise<string[]> {
  const dir = uploadsDir(siteId);
  const out: string[] = [];
  for (const rawId of ids) {
    const id = String(rawId).replace(/[^a-fA-F0-9-]/g, ""); // never let an id escape the dir
    if (!id) continue;
    const abs = join(dir, `${id}.jpg`);
    try {
      await stat(abs);
      out.push(relative(checkoutPath(siteId), abs));
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

/** Boot sweep: purge staged uploads older than 24h across every checkout. */
export async function purgeStaleUploads(siteIds: string[]): Promise<void> {
  const now = Date.now();
  for (const siteId of siteIds) {
    const dir = uploadsDir(siteId);
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
