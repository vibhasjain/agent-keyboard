// Agent Keyboard — HTTP server that drives the real Claude Code CLI against
// per-site git checkouts. The owner sends a prompt (text + optional attachments) from
// a widget embedded in their app; the agent edits that app's repo, commits,
// pushes, and the host redeploys. Every run is a durable job
// (fire-and-forget; the client can disconnect and re-attach). Single user.

import express, { type Request, type Response } from "express";
import cors from "cors";
import busboy from "busboy";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { assertServerConfig } from "./config.js";
import { demoPage, isDemoScene } from "./demo.js";
import {
  allowsSite,
  denySite,
  googleSessionsConfigured,
  mintGoogleSession,
  requireOwner,
  requireOwnerOrGoogle,
  verifyGoogle,
  type AuthedUser,
} from "./auth.js";
import { ASSET_TYPES, registerFeedRoutes } from "./feed.js";
import { getSite, listSitesPublic, pageSlugFor, SITES } from "./sites.js";
import { buildPrompt, runMessageJob, runStreamingSession, InputChannel, STREAMING_SESSION, killAllChildren, rotateConversation, conversationIdFor, sessionIdFor, compactSession } from "./claude.js";
import { acquireSiteLock, ensureCheckout, resetCheckoutToOrigin } from "./checkouts.js";
import { stageUpload, stageFileUpload, resolveAttachments, purgeStaleUploads, outputPath } from "./photos.js";
import { readConversation } from "./conversation.js";
import { startJobsCron } from "./cron.js";
import { mintRealtimeToken } from "./realtime.js";
import { ringRouter } from "./ring.js";
import { seedSkills } from "./skills.js";
import {
  startJob,
  tail,
  getJob,
  cancelJob,
  appendToJob,
  jobSnapshot,
  listActive,
  jobForIdem,
  runningResumeInputs,
  type JobSnapshot,
} from "./jobs.js";
import { writePendingResume, resumeAfterRedeploy } from "./resume.js";
import {
  getJob as dbGetJob,
  listJobs as dbListJobs,
  interruptRunningJobs,
  listRequeueableJobs,
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
    allowedHeaders: ["Authorization", "Content-Type", "X-Auth-Kind"],
    methods: ["GET", "POST", "OPTIONS"],
  }),
);
app.use(express.json({ limit: "1mb" })); // attachments go via multipart, so 1mb is plenty

const authed = requireOwner();
const authedOrGoogle = requireOwnerOrGoogle();

// ─── per-user site/path scoping (see auth.ts UserScope) ─────────────────────
function authedUser(req: Request): AuthedUser | undefined {
  return (req as Request & { user?: AuthedUser }).user;
}

/** The server-authored path constraint appended to every prompt and follow-up
 *  from a path-scoped user. It rides the user turn because Claude sessions are
 *  shared per site/page — the session-level scope note can't be per-user. */
function pathScopeNote(user: AuthedUser | undefined): string {
  const p = user?.scope?.pathPrefix;
  if (!p) return "";
  return (
    `\n\n[Server note — sent by ${user!.email}, a restricted user: for this request you may only create, modify, or delete files under "${p}" in this repo (committing and pushing as usual). ` +
    `If the request would require touching anything outside that path, make no change and reply that this user's access is limited to ${p}.]`
  );
}

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
// Fleet-agent handles → identity colors + page URLs, read once from the relay
// registry so the transcript can render "@home" as that agent's colored tag. A
// missing or malformed registry just means no tags — never a broken widget.
// Quotes are pre-escaped because the placeholder sits inside a string literal
// whose quote style the minifier picks.
const AGENT_TAGS = (() => {
  const paths = [
    join(process.env.SKILLS_SRC_DIR ?? "/app/skills", "relay", "handles.json"),
    join(process.cwd(), "skills", "relay", "handles.json"), // dev: tsx runs from server/
  ];
  for (const p of paths) {
    try {
      const handles = JSON.parse(readFileSync(p, "utf8")).handles as Record<string, { color?: unknown; url?: unknown }>;
      const tags: Record<string, { c: string; u?: string }> = {};
      for (const [handle, h] of Object.entries(handles)) {
        if (typeof h?.color === "string") {
          tags[handle] = {
            c: h.color,
            ...(typeof h.url === "string" ? { u: h.url } : {}),
          };
        }
      }
      return JSON.stringify(tags).replaceAll('"', '\\"');
    } catch {
      /* try the next path */
    }
  }
  return "{}";
})();

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
    .replaceAll("__AK_SUPABASE_ANON_KEY__", process.env.SUPABASE_ANON_KEY ?? "")
    .replaceAll(
      "__AK_PAGE_SCOPED_SITES__",
      SITES.filter((s) => s.sessionScope === "page").map((s) => s.id).join(","),
    )
    .replaceAll("__AK_AGENT_TAGS__", AGENT_TAGS);
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

// ─── /welcome — set-your-password landing for provisioned users ─────────────
// The provision-user skill sends a Supabase invite/recovery email whose link
// redirects here with tokens in the URL hash (never sent to this server). The
// page PUTs the new password straight to Supabase with the anon key. Open
// route: without a valid token in the hash it can do nothing.
app.get("/welcome", (_req, res) => {
  // JSON.stringify alone doesn't escape "<" — a "</script>" substring in a
  // config value would terminate the inline script block. < is inert.
  const js = (v: string) => JSON.stringify(v).replace(/</g, "\\u003c");
  const sb = js(process.env.SUPABASE_URL ?? "");
  const anon = js(process.env.SUPABASE_ANON_KEY ?? "");
  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Agent Keyboard — welcome</title>
<style>
  :root{--bg:#0a0a0a;--ink:#f5f1ea;--ink2:#b8b2a7;--ink3:#6f6a61;--rule:#211f1c;--amber:#ffb86b;--err:#f97066;--ok:#6dd396}
  html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
  main{max-width:420px;margin:18vh auto 0;padding:0 20px}
  h1{font-size:17px;font-weight:600;margin:0 0 6px}
  h1 .k{margin-right:8px}
  p{color:var(--ink2);margin:0 0 22px;font-size:13.5px}
  label{display:block;color:var(--ink3);font-size:11px;letter-spacing:.06em;margin:14px 0 4px}
  input{width:100%;box-sizing:border-box;background:transparent;border:none;border-bottom:1px solid var(--rule);color:var(--ink);font:inherit;padding:6px 2px;outline:none}
  input:focus{border-bottom-color:var(--amber)}
  button{margin-top:24px;background:var(--amber);color:#141310;border:none;border-radius:8px;padding:10px 18px;font:600 13.5px ui-monospace,monospace;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  .msg{margin-top:16px;font-size:13px;min-height:1.4em}
  .msg.err{color:var(--err)} .msg.ok{color:var(--ok)}
</style></head>
<body><main>
  <h1><span class="k">⌨️</span>Agent Keyboard</h1>
  <p>You've been invited. Set a password to finish — then sign in from the bar on the site.</p>
  <form id="f">
    <label for="pw">new password</label>
    <input id="pw" type="password" autocomplete="new-password" minlength="8" required>
    <label for="pw2">repeat it</label>
    <input id="pw2" type="password" autocomplete="new-password" minlength="8" required>
    <button id="go" type="submit">set password</button>
  </form>
  <div class="msg" id="msg"></div>
<script>
  const SB = ${sb}, ANON = ${anon};
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("access_token");
  const msg = (t, cls) => { const m = document.getElementById("msg"); m.textContent = t; m.className = "msg " + (cls||""); };
  if (params.get("error_description")) msg(params.get("error_description"), "err");
  else if (!token) msg("This page needs the link from your invite email — open it from there.", "err");
  document.getElementById("f").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = document.getElementById("pw").value, pw2 = document.getElementById("pw2").value;
    if (pw !== pw2) return msg("Passwords don't match.", "err");
    if (!token) return msg("Missing invite token — open this page from your email link.", "err");
    const go = document.getElementById("go"); go.disabled = true;
    try {
      const r = await fetch(SB.replace(/\\/$/, "") + "/auth/v1/user", {
        method: "PUT",
        headers: { Authorization: "Bearer " + token, apikey: ANON, "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      if (r.ok) msg("Password set. Head back to the site and sign in with your email + this password.", "ok");
      else msg("Couldn't set the password (" + r.status + ") — the link may have expired; ask for a fresh invite.", "err");
    } catch { msg("Network error — try again.", "err"); }
    go.disabled = false;
  });
</script>
</main></body></html>`);
});

// ─── demo scenes (open, static, dummy data — see demo.ts) ───────────────────
function demoJsPath(): string | null {
  const primary = process.env.DEMO_JS_PATH ?? "/app/widget/demo.js";
  if (existsSync(primary)) return primary;
  const devFallback = join(SERVER_DIR, "..", "widget", "dist", "demo.js");
  if (existsSync(devFallback)) return devFallback;
  return null;
}
app.get("/demo.js", (_req, res) => {
  const p = demoJsPath();
  if (!p) {
    res.status(404).type("text/plain").send("// demo.js is not built yet");
    return;
  }
  res.setHeader("Content-Type", "text/javascript");
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=86400");
  res.sendFile(p);
});
app.get("/demo/:scene", (req, res) => {
  const scene = String(req.params.scene ?? "");
  if (!isDemoScene(scene)) {
    res.status(404).type("text/plain").send("unknown demo scene");
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(demoPage(scene));
});

// ─── agent-produced images (open, unguessable uuid path) ─────────────────────
// Images the agent shows in the chat load via <img>, which can't carry the auth
// header — so this route is open, gated only by the unguessable uuid filename
// (single-owner product; the id only ever reaches the owner via an authed frame).
app.get("/sites/:siteId/assets/:name", (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  const name = String(req.params.name ?? "");
  const abs = site ? outputPath(site.id, name) : null;
  if (!abs || !existsSync(abs)) {
    res.status(404).type("text/plain").send("not found");
    return;
  }
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  res.setHeader("Content-Type", ASSET_TYPES[ext] ?? "application/octet-stream");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.sendFile(abs);
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
app.post("/sites/:siteId/session", async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  if (!googleSessionsConfigured()) {
    res.status(500).json({ error: "server not configured: SESSION_SECRET unset" });
    return;
  }
  const idToken = typeof req.body?.idToken === "string" ? req.body.idToken.trim() : "";
  if (!idToken) {
    res.status(400).json({ error: "idToken required" });
    return;
  }
  const user = await verifyGoogle(idToken);
  if (!user) {
    res.status(401).json({ error: "invalid session or not authorized" });
    return;
  }
  (req as Request & { user?: AuthedUser }).user = user;
  if (denySite(req, res, site.id)) return;
  const { sessionToken, exp } = mintGoogleSession(user);
  res.json({ sessionToken, exp, email: user.email });
});

registerFeedRoutes(app, authedOrGoogle);

app.get("/sites", authed, (req, res) => {
  const user = authedUser(req);
  res.json(listSitesPublic().filter((s) => !user || allowsSite(user, s.id)));
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
  if (denySite(req, res, site.id)) return;
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
  const ac = new AbortController();
  // With the streaming-session flag on, a message opens a long-lived session that
  // stays open for follow-ups; otherwise it's a classic one-shot job.
  const input = STREAMING_SESSION ? new InputChannel() : null;
  // On a page-scoped site the conversation follows the page ("" = site root);
  // on everything else the slug is always "" and behavior is unchanged.
  const pageSlug = pageSlugFor(site, page);
  // Path-scoped users: the constraint travels with the turn itself; the stored
  // job prompt stays the user's own words.
  const promptText = text + pathScopeNote(authedUser(req));
  const sender = authedUser(req)?.email;
  const gen = input
    ? runStreamingSession(site, { text: promptText, page, pageSlug, attachmentPaths, sender }, input, ac.signal)
    : runMessageJob(site, { text: promptText, page, pageSlug, attachmentPaths, sender }, ac.signal);
  // Record which Claude session this job drives, so an auto-resume after a
  // self-triggered redeploy can pick the turn back up with --resume.
  const conversationId = await conversationIdFor(site.id, pageSlug);
  const sessionId = sessionIdFor(conversationId);
  const job = await startJob({
    siteId: site.id,
    prompt: text,
    page,
    pageSlug,
    gen,
    abort: () => ac.abort(),
    idemKey: idemKey || undefined,
    streaming: !!input,
    input,
    conversationId,
    sessionId,
    resumeCount: 0,
  });
  await streamJobTail(req, res, job);
});

/** Inject a follow-up message into a running streaming session (M2). 404/409 if
 *  the site is unknown or the job isn't an open streaming session. */
app.post("/sites/:siteId/jobs/:jobId/messages", authed, (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  if (denySite(req, res, site.id)) return;
  const text = typeof (req.body as { text?: unknown })?.text === "string" ? (req.body as { text: string }).text : "";
  if (!text.trim()) {
    res.status(400).json({ error: "text required" });
    return;
  }
  // The job must belong to the site in the URL — otherwise the site check
  // above could be sidestepped by posting another site's jobId under this one.
  const target = getJob(req.params.jobId ?? "");
  if (!target || target.siteId !== site.id) {
    res.status(409).json({ error: "job not accepting messages" });
    return;
  }
  // Follow-ups get the same "[Sent from … by <email>]" header as opening turns so
  // the transcript can attribute them; the page is unknown here, "/" is fine.
  const user = authedUser(req);
  const ok = appendToJob(
    req.params.jobId ?? "",
    buildPrompt(site, { text: text + pathScopeNote(user), page: "/", attachmentPaths: [], sender: user?.email }),
  );
  if (!ok) {
    res.status(409).json({ error: "job not accepting messages" });
    return;
  }
  res.json({ ok: true });
});

/** Upload a single attachment (multipart field `photo` or `file`); returns {id, path} to attach. */
app.post("/sites/:siteId/uploads", authed, (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  if (denySite(req, res, site.id)) return;
  const bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: 15 * 1024 * 1024 } });
  const chunks: Buffer[] = [];
  let fieldName: "photo" | "file" | null = null;
  let filename = "attachment";
  let mime = "";
  let tooBig = false;
  let handled = false;
  const finish = (status: number, payload: unknown) => {
    if (handled) return;
    handled = true;
    res.status(status).json(payload);
  };

  bb.on("file", (name, stream, info) => {
    if (fieldName || (name !== "photo" && name !== "file")) {
      stream.resume();
      return;
    }
    fieldName = name;
    filename = info.filename || (name === "photo" ? "photo.jpg" : "attachment");
    mime = info.mimeType || "";
    stream.on("data", (d: Buffer) => chunks.push(d));
    stream.on("limit", () => {
      tooBig = true;
    });
  });
  bb.on("close", async () => {
    if (tooBig) return finish(413, { error: "attachment too large (max 15MB)" });
    if (!fieldName || chunks.length === 0) return finish(400, { error: "no `photo` or `file` field" });
    try {
      await ensureCheckout(site);
      const input = Buffer.concat(chunks);
      const staged = fieldName === "photo"
        ? await stageUpload(site.id, input)
        : await stageFileUpload(site.id, input, filename, mime);
      finish(200, {
        id: staged.id,
        path: staged.path,
        kind: staged.kind,
        name: staged.name,
        mime: staged.mime,
        size: staged.size,
      });
    } catch (err) {
      finish(500, { error: String(err).slice(0, 300) });
    }
  });
  bb.on("error", (err: unknown) => finish(400, { error: String(err).slice(0, 300) }));
  req.pipe(bb);
});

/** Forcefully stop a running job (kills the CLI child, releases the lock). The
 *  job's stream then delivers a terminal 'stopped' error to every viewer. */
app.post("/jobs/:jobId/cancel", authed, (req, res) => {
  const job = getJob(req.params.jobId ?? "");
  if (job && denySite(req, res, job.siteId)) return;
  const stopped = cancelJob(req.params.jobId ?? "");
  res.json({ stopped });
});

/** Clean slate for a site: stop live work, discard local checkout changes,
 *  reset to latest origin/<branch>, and rotate to a fresh conversation. */
app.post("/sites/:siteId/restart", authed, async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  if (denySite(req, res, site.id)) return;

  // On a page-scoped site, restart from a page rotates only that page's
  // conversation; the checkout is shared across pages, so only a site-root
  // restart hard-resets it.
  const pageSlug = pageSlugFor(site, (req.body as { page?: unknown } | undefined)?.page);
  const running = listActive(site.id, pageSlug).filter((j) => j.status === "running");
  for (const job of running) cancelJob(job.job_id);

  let release: (() => void) | undefined;
  try {
    release = await acquireSiteLock(site.id);
    const reset = pageSlug === "" ? await resetCheckoutToOrigin(site) : null;
    const conversationId = await rotateConversation(site.id, pageSlug);
    res.json({
      ok: true,
      cancelled: running.length,
      cleared: true,
      conversation_id: conversationId,
      reset,
    });
  } catch (err) {
    res.status(500).json({ error: String((err as Error)?.message ?? err).slice(0, 300) });
  } finally {
    release?.();
  }
});

/** On-demand compaction of the site's Claude session (the settings-menu "Compact"). */
app.post("/sites/:siteId/compact", authed, async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  if (denySite(req, res, site.id)) return;
  // Close any open session so the lock frees promptly; compaction summarizes the
  // session's memory anyway, and the next message resumes it compacted.
  const pageSlug = pageSlugFor(site, (req.body as { page?: unknown } | undefined)?.page);
  for (const job of listActive(site.id, pageSlug).filter((j) => j.status === "running")) cancelJob(job.job_id);
  try {
    const compacted = await compactSession(site.id, pageSlug);
    res.json({ compacted });
  } catch (err) {
    res.status(500).json({ error: String((err as Error)?.message ?? err).slice(0, 300) });
  }
});

/** Re-attach to a running or finished job's stream. */
app.get("/jobs/:jobId/stream", authed, async (req, res) => {
  const jobId = req.params.jobId ?? "";
  const job = getJob(jobId);
  if (job) {
    if (denySite(req, res, job.siteId)) return;
    await streamJobTail(req, res, job);
    return;
  }
  // Not in the registry: fall back to the durable DB row.
  const row = await dbGetJob(jobId);
  if (row && denySite(req, res, row.site_id)) return;
  openSse(res);
  if (!row) {
    writeFrame(res, "error", { kind: "not_found", detail: "Unknown job." });
    res.end();
    return;
  }
  writeFrame(res, "job", { job_id: row.job_id, target: row.site_id, status: row.status });
  if (row.status_line) writeFrame(res, "status", row.status_line);
  if (row.status === "done") {
    // A done streaming session's stored result is its last TURN payload
    // (open: true). Replaying that verbatim makes the widget re-open the
    // session and reconnect forever — the session is over, so say so.
    if ((row.result as { open?: unknown } | null)?.open === true) writeFrame(res, "closed", {});
    else writeFrame(res, "result", row.result ?? {});
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
  if (siteId && denySite(req, res, siteId)) return;
  // No siteId lists active jobs across ALL sites — nothing there for a scoped user.
  if (!siteId && authedUser(req)?.scope) {
    res.json({ jobs: [] });
    return;
  }
  const site = siteId ? getSite(siteId) : null;
  // Page filter only when the site opted into per-page sessions AND the caller
  // sent a page — old cached widgets omit it and stay unfiltered (today's view).
  const slug =
    site?.sessionScope === "page" && typeof req.query.page === "string"
      ? pageSlugFor(site, req.query.page)
      : undefined;
  const rows = (siteId ? await dbListJobs(siteId) : []).filter(
    (row) => slug === undefined || pageSlugFor(site!, row.page ?? "") === slug,
  );
  const live = new Map(listActive(siteId || undefined, slug).map((s) => [s.job_id, s]));
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
    if (denySite(req, res, snap.site_id)) return;
    res.json(snap);
    return;
  }
  const row = await dbGetJob(jobId);
  if (!row) {
    res.status(404).json({ error: "job not found" });
    return;
  }
  if (denySite(req, res, row.site_id)) return;
  res.json(rowToSnapshot(row));
});

/** Conversation history (chat bubbles) from the agent's durable session JSONL. */
app.get("/sites/:siteId/conversation", authed, async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  if (denySite(req, res, site.id)) return;
  const limit = Number(req.query.limit ?? 40);
  const before = Number(req.query.before ?? 0);
  const pageSlug = pageSlugFor(site, req.query.page);
  try {
    const out = await readConversation(site.id, {
      limit: Number.isFinite(limit) ? limit : 40,
      before: Number.isFinite(before) ? before : 0,
      pageSlug,
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

// Ring webhook + focus registry (see ring.ts).
app.use(ringRouter());

// ─── boot + graceful shutdown ────────────────────────────────────────────────
const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`agent-keyboard listening on :${port}`);
  if (process.env.JOBS_CRON_DISABLED !== "1") startJobsCron();
  // Purge stale staged uploads, then reconcile any jobs the last process left
  // "running" (machine slept / crashed mid-job). Both tolerate an unreachable
  // Supabase / missing checkouts — log and continue, never block serving.
  void purgeStaleUploads(SITES.map((s) => s.id)).catch((e) =>
    console.error("[boot] purge uploads failed", e),
  );
  // Sweep, but first rescue messages that never started (queued/syncing when
  // the last process died — e.g. a burst of ring presses behind a deploy):
  // their prompts re-enter the queue verbatim instead of dying as 'interrupted'.
  void (async () => {
    const requeue = await listRequeueableJobs().catch(() => [] as JobRow[]);
    await interruptRunningJobs();
    const secret = process.env.AK_INTERNAL_SECRET ?? "";
    if (!secret) return;
    for (const row of requeue) {
      fetch(`http://127.0.0.1:${port}/sites/${encodeURIComponent(row.site_id)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-ak-internal": secret },
        body: JSON.stringify({
          text: row.prompt,
          page: row.page ?? "/",
          idemKey: `requeue-${row.job_id}`,
        }),
      })
        .then((r) => {
          void r.body?.cancel();
          console.log(`[boot] requeued ${row.job_id} -> ${row.site_id} (${r.status})`);
        })
        .catch((e) => console.error(`[boot] requeue ${row.job_id} failed`, String(e)));
    }
  })().catch((e) => console.error("[boot] job sweep failed", e));
  void resumeAfterRedeploy().catch((e) => console.error("[boot] auto-resume failed", e));
  void seedSkills().catch((e) => console.error("[boot] skill seed failed", e));
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} — marking running jobs interrupted, killing children`);
  try {
    writePendingResume(runningResumeInputs());
  } catch {
    /* auto-resume is best-effort; never block shutdown */
  }
  killAllChildren();
  await interruptRunningJobs().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
