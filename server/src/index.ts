// Agent Keyboard — HTTP server that drives the real Claude Code CLI against
// per-site git checkouts. The owner sends a prompt (text + optional photos) from
// a widget on one of their static sites; the agent edits the site's code,
// commits, pushes to main, and Netlify redeploys. Every run is a durable job
// (fire-and-forget; the client can disconnect and re-attach). Single user.

import express, { type Request, type Response } from "express";
import cors from "cors";
import busboy from "busboy";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { assertServerConfig } from "./config.js";
import { requireOwner } from "./auth.js";
import { getSite, listSitesPublic, SITES } from "./sites.js";
import { runMessageJob, killAllChildren } from "./claude.js";
import { ensureCheckout } from "./checkouts.js";
import { stageUpload, resolveAttachments, purgeStaleUploads } from "./photos.js";
import { readConversation } from "./conversation.js";
import { mintRealtimeToken } from "./realtime.js";
import {
  startJob,
  tail,
  getJob,
  jobSnapshot,
  listActive,
  jobForIdem,
  type JobSnapshot,
} from "./jobs.js";
import {
  getJob as dbGetJob,
  listJobs as dbListJobs,
  interruptRunningJobs,
  type JobRow,
} from "./jobstore.js";
import { openSse, startKeepalive, writeFrame } from "./sse.js";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

// Fail loudly and actionably before doing anything else if the deploy is
// missing required config (SITES, ALLOWED_EMAIL, Supabase/GitHub creds, …).
assertServerConfig();

const app = express();

// ─── CORS: the widget calls this API cross-origin from the owner's sites ───
// Allowed browser origins are derived from the configured sites (apex + www of
// each domain), plus any extra full origins in EXTRA_ORIGINS (comma-separated).
const STATIC_ORIGINS = new Set<string>();
for (const s of SITES) {
  STATIC_ORIGINS.add(`https://${s.domain}`);
  STATIC_ORIGINS.add(`https://www.${s.domain}`);
}
for (const o of (process.env.EXTRA_ORIGINS ?? "").split(",")) {
  const trimmed = o.trim();
  if (trimmed) STATIC_ORIGINS.add(trimmed);
}
function corsOrigin(
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void,
): void {
  if (!origin) return cb(null, true); // non-browser / same-origin (curl, server-to-server)
  if (STATIC_ORIGINS.has(origin)) return cb(null, true);
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
  return cb(null, false); // disallowed: no CORS headers, browser blocks the read
}
app.use(
  cors({
    origin: corsOrigin,
    allowedHeaders: ["Authorization", "Content-Type"],
    methods: ["GET", "POST", "OPTIONS"],
  }),
);
app.use(express.json({ limit: "1mb" })); // photos go via multipart, so 1mb is plenty

const authed = requireOwner();

// ─── open routes ───────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "agent-keyboard" });
});

/** The embeddable widget bundle. Public, cacheable, embeddable from any origin. */
function widgetJsPath(): string | null {
  const primary = process.env.WIDGET_JS_PATH ?? "/app/widget/widget.js";
  if (existsSync(primary)) return primary;
  const devFallback = join(SERVER_DIR, "..", "widget", "dist", "widget.js");
  if (existsSync(devFallback)) return devFallback;
  return null;
}
// The built bundle ships with `__AK_` placeholders for the Supabase URL + anon
// key; we inject the real values here so they live only in the server's env,
// never in the repo. Cache the injected buffer in production; in dev, re-read
// every request so a rebuild is picked up without a restart.
let widgetJsCache: Buffer | null = null;
function widgetJs(): Buffer | null {
  if (widgetJsCache) return widgetJsCache;
  const p = widgetJsPath();
  if (!p) return null;
  const src = readFileSync(p, "utf8")
    .replaceAll("__AK_SUPABASE_URL__", process.env.SUPABASE_URL ?? "")
    .replaceAll("__AK_SUPABASE_ANON_KEY__", process.env.SUPABASE_ANON_KEY ?? "");
  const buf = Buffer.from(src, "utf8");
  if (process.env.NODE_ENV === "production") widgetJsCache = buf;
  return buf;
}
app.get("/widget.js", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const buf = widgetJs();
  if (!buf) {
    res.status(404).type("text/plain").send("// widget.js is not built yet");
    return;
  }
  res.setHeader("Content-Type", "text/javascript");
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=86400");
  res.setHeader("Content-Length", String(buf.length));
  res.send(buf);
});

// ─── SSE helpers ─────────────────────────────────────────────────────────────
/** Stream a job's tail as the SSE response; detach cleanly on client disconnect. */
async function streamJobTail(
  req: Request,
  res: Response,
  job: Parameters<typeof tail>[0],
): Promise<void> {
  openSse(res);
  const stopKa = startKeepalive(res);
  const gen = tail(job);
  req.on("close", () => {
    void gen.return(undefined); // ends the tail; its finally detaches the subscriber
  });
  try {
    for await (const [event, payload] of gen) writeFrame(res, event, payload);
  } catch (err) {
    writeFrame(res, "error", { kind: "server_error", detail: String(err).slice(0, 300) });
  } finally {
    stopKa();
    try {
      res.end();
    } catch {
      /* already closed */
    }
  }
}

/** Normalize a DB job row into the same snapshot shape the registry emits. */
function rowToSnapshot(row: JobRow): JobSnapshot {
  return {
    job_id: row.job_id,
    site_id: row.site_id,
    kind: row.kind,
    status: row.status,
    status_line: row.status_line ?? {},
    result: row.result ?? null,
    error: row.error ?? null,
    created_at: row.created_at ?? new Date().toISOString(),
    updated_at: row.updated_at ?? new Date().toISOString(),
  };
}

// ─── authed routes ───────────────────────────────────────────────────────────
app.get("/sites", authed, (_req, res) => {
  res.json(listSitesPublic());
});

/**
 * Send a prompt to a site. The POST response IS the SSE stream (a tail of the
 * durable job): job → status* → assistant* → result | error.
 */
app.post("/sites/:siteId/messages", authed, async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  const body = (req.body ?? {}) as {
    text?: unknown;
    page?: unknown;
    idemKey?: unknown;
    attachmentIds?: unknown;
  };
  const text = typeof body.text === "string" ? body.text : "";
  const page = typeof body.page === "string" ? body.page : "/";
  const idemKey = typeof body.idemKey === "string" && body.idemKey ? body.idemKey : "";
  const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : [];
  if (!text.trim() && attachmentIds.length === 0) {
    res.status(400).json({ error: "text or attachmentIds required" });
    return;
  }

  // Idempotency: a duplicate POST (retry / double-fire) re-tails the original job.
  if (idemKey) {
    const existing = jobForIdem(idemKey);
    if (existing) {
      await streamJobTail(req, res, existing);
      return;
    }
  }

  const attachmentPaths = attachmentIds.length
    ? await resolveAttachments(site.id, attachmentIds)
    : [];
  const gen = runMessageJob(site, { text, page, attachmentPaths });
  const job = await startJob({ siteId: site.id, prompt: text, page, gen, idemKey: idemKey || undefined });
  await streamJobTail(req, res, job);
});

/** Upload a single photo (multipart field `photo`); returns {id, path} to attach. */
app.post("/sites/:siteId/uploads", authed, (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  const bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: 15 * 1024 * 1024 } });
  const chunks: Buffer[] = [];
  let gotFile = false;
  let tooBig = false;
  let handled = false;
  const finish = (status: number, payload: unknown) => {
    if (handled) return;
    handled = true;
    res.status(status).json(payload);
  };

  bb.on("file", (name, stream) => {
    if (name !== "photo") {
      stream.resume();
      return;
    }
    gotFile = true;
    stream.on("data", (d: Buffer) => chunks.push(d));
    stream.on("limit", () => {
      tooBig = true;
    });
  });
  bb.on("close", async () => {
    if (tooBig) return finish(413, { error: "photo too large (max 15MB)" });
    if (!gotFile || chunks.length === 0) return finish(400, { error: "no `photo` field" });
    try {
      await ensureCheckout(site);
      const staged = await stageUpload(site.id, Buffer.concat(chunks));
      finish(200, { id: staged.id, path: staged.path });
    } catch (err) {
      finish(500, { error: String(err).slice(0, 300) });
    }
  });
  bb.on("error", (err: unknown) => finish(400, { error: String(err).slice(0, 300) }));
  req.pipe(bb);
});

/** Re-attach to a running or finished job's stream. */
app.get("/jobs/:jobId/stream", authed, async (req, res) => {
  const jobId = req.params.jobId ?? "";
  const job = getJob(jobId);
  if (job) {
    await streamJobTail(req, res, job);
    return;
  }
  // Not in the registry: fall back to the durable DB row.
  const row = await dbGetJob(jobId);
  openSse(res);
  if (!row) {
    writeFrame(res, "error", { kind: "not_found", detail: "Unknown job." });
    res.end();
    return;
  }
  writeFrame(res, "job", { job_id: row.job_id, target: row.site_id, status: row.status });
  if (row.status_line) writeFrame(res, "status", row.status_line);
  if (row.status === "done") {
    writeFrame(res, "result", row.result ?? {});
  } else if (row.status === "running") {
    // In the DB but not the registry: the machine restarted mid-job (an orphan
    // the boot sweep hasn't reconciled). Report it honestly.
    writeFrame(res, "error", {
      kind: "interrupted",
      detail: "The server restarted while this job was running.",
    });
  } else {
    writeFrame(res, "error", row.error ?? { kind: "job_failed", detail: "The job failed." });
  }
  res.end();
});

/** List running jobs + a 10-minute finished window for a site (registry ∪ DB). */
app.get("/jobs", authed, async (req, res) => {
  const siteId = typeof req.query.siteId === "string" ? req.query.siteId : "";
  const rows = siteId ? await dbListJobs(siteId) : [];
  const live = new Map(listActive(siteId || undefined).map((s) => [s.job_id, s]));
  const merged: JobSnapshot[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    merged.push(live.get(row.job_id) ?? rowToSnapshot(row));
    live.delete(row.job_id);
    seen.add(row.job_id);
  }
  for (const snap of live.values()) if (!seen.has(snap.job_id)) merged.push(snap);
  res.json({ jobs: merged });
});

/** One job's snapshot (registry first, then DB). */
app.get("/jobs/:jobId", authed, async (req, res) => {
  const jobId = req.params.jobId ?? "";
  const snap = jobSnapshot(jobId);
  if (snap) {
    res.json(snap);
    return;
  }
  const row = await dbGetJob(jobId);
  if (!row) {
    res.status(404).json({ error: "job not found" });
    return;
  }
  res.json(rowToSnapshot(row));
});

/** Conversation history (chat bubbles) from the agent's durable session JSONL. */
app.get("/sites/:siteId/conversation", authed, async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  const limit = Number(req.query.limit ?? 40);
  const before = Number(req.query.before ?? 0);
  try {
    const out = await readConversation(site.id, {
      limit: Number.isFinite(limit) ? limit : 40,
      before: Number.isFinite(before) ? before : 0,
    });
    res.json(out);
  } catch (err) {
    console.error("[conversation] error", err);
    res.status(500).json({ error: String(err).slice(0, 300) });
  }
});

/** Mint a short-lived OpenAI realtime transcription token (push-to-talk voice). */
app.post("/realtime/token", authed, async (_req, res) => {
  const out = await mintRealtimeToken();
  if ("error" in out) {
    res.status(out.error === "voice_not_configured" ? 503 : 502).json(out);
    return;
  }
  res.json(out);
});

// ─── boot + graceful shutdown ────────────────────────────────────────────────
const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`agent-keyboard listening on :${port}`);
  // Purge stale staged uploads, then reconcile any jobs the last process left
  // "running" (machine slept / crashed mid-job). Both tolerate an unreachable
  // Supabase / missing checkouts — log and continue, never block serving.
  void purgeStaleUploads(SITES.map((s) => s.id)).catch((e) =>
    console.error("[boot] purge uploads failed", e),
  );
  void interruptRunningJobs().catch((e) => console.error("[boot] job sweep failed", e));
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} — marking running jobs interrupted, killing children`);
  killAllChildren();
  await interruptRunningJobs().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
