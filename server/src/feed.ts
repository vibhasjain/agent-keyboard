import type { Express, RequestHandler } from "express";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

import { denySite } from "./auth.js";
import { checkoutPath } from "./checkouts.js";
import { getSite } from "./sites.js";

export const ASSET_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  json: "application/json",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  html: "text/html",
  pdf: "application/pdf",
  svg: "image/svg+xml",
  ics: "text/calendar",
};

export function registerFeedRoutes(app: Express, auth: RequestHandler): void {
  app.get("/sites/:siteId/feed", auth, async (req, res) => {
    const site = getSite(req.params.siteId ?? "");
    if (!site) {
      res.status(404).json({ error: "unknown site" });
      return;
    }
    if (denySite(req, res, site.id)) return;
    res.setHeader("Cache-Control", "no-store");
    try {
      const feed = await readFile(join(checkoutPath(site.id), "cloud", "feed.json"), "utf8");
      res.type("application/json").send(feed);
    } catch {
      res.json({ updatedAt: null, candidates: [], meetings: [] });
    }
  });

  app.get("/sites/:siteId/files/*", auth, (req, res) => {
    const site = getSite(req.params.siteId ?? "");
    if (!site) {
      res.status(404).json({ error: "unknown site" });
      return;
    }
    if (denySite(req, res, site.id)) return;
    const raw = typeof req.params[0] === "string" ? req.params[0] : "";
    let relative: string;
    try {
      relative = decodeURIComponent(raw);
    } catch {
      res.status(400).json({ error: "malformed file path" });
      return;
    }
    if (relative.includes("\0")) {
      res.status(404).type("text/plain").send("not found");
      return;
    }
    const base = resolve(checkoutPath(site.id), "cloud", "files");
    const absolutePath = resolve(base, relative);
    if (absolutePath !== base && !absolutePath.startsWith(base + sep)) {
      res.status(404).type("text/plain").send("not found");
      return;
    }
    let isFile = false;
    try {
      isFile = statSync(absolutePath).isFile();
    } catch {
      /* missing */
    }
    if (!isFile) {
      res.status(404).type("text/plain").send("not found");
      return;
    }
    const ext = extname(absolutePath).slice(1).toLowerCase();
    res.setHeader("Content-Type", ASSET_TYPES[ext] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(absolutePath);
  });
}
