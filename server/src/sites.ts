// The allow-list of sites the Agent Keyboard can edit, loaded from the SITES env
// var (see config.ts / SELF_HOSTING.md). Each entry maps a stable id to the repo
// it lives in, the branch its host deploys from, and the public domain the widget
// is embedded on (used for CORS + the "[Sent from …]" prompt context). This is
// intentionally an allow-list: the agent may only ever operate on one of these
// checkouts, never an arbitrary repo.

import { loadSites, type Site } from "./config.js";

export type { Site };

export const SITES: Site[] = safeLoadSites();

function safeLoadSites(): Site[] {
  // assertServerConfig() (index.ts, first thing at boot) validates SITES and
  // exits with a readable error before anything reads this. We swallow a parse
  // error here only so that a bad SITES surfaces through that consolidated boot
  // block rather than an ugly import-time stack trace.
  try {
    return loadSites();
  } catch {
    return [];
  }
}

const BY_ID = new Map(SITES.map((s) => [s.id, s]));

export function getSite(siteId: string): Site | null {
  return BY_ID.get(siteId) ?? null;
}

/** Public shape for GET /sites. */
export function listSitesPublic(): { id: string; domain: string }[] {
  return SITES.map((s) => ({ id: s.id, domain: s.domain }));
}
