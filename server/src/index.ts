// Agent Keyboard — HTTP server that drives the real Claude Code CLI against
// per-site git checkouts. The owner sends a prompt (text + optional attachments) from
// a widget embedded in their app; the agent edits that app's repo, commits,
// pushes, and the host redeploys. Every run is a durable job
// (fire-and-forget; the client can disconnect and re-attach). Single user.

import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import cors from "cors";
import busboy from "busboy";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { assertServerConfig } from "./config.js";
import { demoPage, isDemoScene } from "./demo.js";
import {
  allowsSite,
  denySite,
  googleSessionsConfigured,
  mintGoogleSession,
  pathScopeNote,
  requireOwner,
  requireOwnerOrGoogle,
  verifyGoogle,
  type AuthedUser,
  listAgentKeys,
  mintAgentKey,
  revokeAgentKey,
  siteMembers,
  isOwnerEmail,
} from "./auth.js";
import { ASSET_TYPES, registerFeedRoutes } from "./feed.js";
import { getSite, listSitesPublic, pageSlugFor, SITES } from "./sites.js";
import { archiveSandbox, closedReason, createSandbox, getSandbox, listSandboxes, pruneSandboxes, publishSandbox, sandboxForOrigin, setSandboxRedirect, waitForPreview } from "./sandboxes.js";
import { buildPrompt, mcpFor, isTeammate, runMessageJob, runStreamingSession, InputChannel, STREAMING_SESSION, killAllChildren, rotateConversation, conversationIdFor, sessionIdFor, sessionFileExists, compactSession } from "./claude.js";
import { acquireSiteLock, checkoutPath, commitFile, removeCheckout, ensureCheckout, resetCheckoutToOrigin, startCheckoutPruning, tryAcquireSiteLock } from "./checkouts.js";
import { stageUpload, stageFileUpload, resolveAttachments, purgeStaleUploads, outputPath } from "./photos.js";
import { readConversation } from "./conversation.js";
import { addTeamNote, emailMention, handleOf, markClicked, noticeUrl } from "./team.js";
import { NOTE_IMAGE_TYPES, deleteNote, listNotes, noteImagePath, noteMeta, noteTree, notesNote, readNote, saveNoteImage, validNoteImage, validNoteName, validOrder, writeNote, writeOrder } from "./notes.js";
import { startJobsCron } from "./cron.js";
import { mintRealtimeToken } from "./realtime.js";
import { browserTasksRouter, closeAllBrowserTasks } from "./browser.js";
import { ringRouter } from "./ring.js";
import { runChecks, setupRouter } from "./setup.js";
import { keepTranscripts, seedCodexConfig, seedSkills } from "./skills.js";
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
  publishBrowserStatus,
  type JobSnapshot,
} from "./jobs.js";
import { writePendingResume, resumeAfterRedeploy } from "./resume.js";
import { exportPreview, importFrom, mintExportToken, redeemExportToken, streamExport } from "./migrate.js";
import {
  getJob as dbGetJob,
  listJobs as dbListJobs,
  interruptRunningJobs,
  markRequeued,
  listRequeueableJobs,
  type JobRow,
} from "./jobstore.js";
import { openSse, startKeepalive, writeFrame } from "./sse.js";
import { readEvents, setOnHookDisabled, setWebhook } from "./events.js";
import { startBrowserDetection, streamScreen, withBrowserStatus } from "./screen.js";

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
  if (!s.sandbox && !s.pushBranch) {
    console.log(`agent-keyboard: sandbox not configured for site "${s.id}" — changes push straight to ${s.branch}; add "sandbox":{} to enable branch previews (see "Sandboxes" in SELF_HOSTING.md)`);
  } else if (s.sandbox && !process.env.AK_INTERNAL_SECRET) {
    console.warn(`agent-keyboard: site "${s.id}" has sandbox configured but AK_INTERNAL_SECRET is unset — the agent can't create sandboxes ("sign in required"); set it to a random string (openssl rand -hex 32)`);
  } else if (s.sandbox && s.guest) {
    console.warn(`agent-keyboard: site "${s.id}" is guest:true, so its agent runs without AK_INTERNAL_SECRET and can't create sandboxes; drop guest or sandbox`);
  }
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
  if (STATIC_ORIGINS.has(origin) || sandboxForOrigin(origin)) return cb(null, true);
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
  return cb(null, false); // disallowed: no CORS headers, browser blocks the read
}
app.use(
  cors({
    origin: corsOrigin,
    allowedHeaders: ["Authorization", "Content-Type", "X-Auth-Kind"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  }),
);
// Idle stop (IDLE_STOP_MINUTES; unset = always on). Fly's own auto-stop only
// sees inbound connections, so it would stop the machine under a job whose tab
// was closed. The server knows better: it exits 0 only when no request is
// open, no job is queued or running, and nothing has called for that long;
// Fly starts the machine again on the next request (auto_start_machines).
// A cron slot slept through runs at the next wake (cron.ts catches up).
let lastActivity = Date.now();
let openRequests = 0;
app.use((_req, res, next) => {
  lastActivity = Date.now();
  openRequests++;
  res.on("close", () => {
    openRequests--;
    lastActivity = Date.now();
  });
  next();
});
function startIdleStop(): void {
  const idleMs = Number(process.env.IDLE_STOP_MINUTES ?? 0) * 60_000;
  if (!(idleMs > 0)) return;
  setInterval(() => {
    if (openRequests > 0 || listActive().some((job) => job.status === "queued" || job.status === "running")) {
      lastActivity = Date.now();
      return;
    }
    if (Date.now() - lastActivity < idleMs) return;
    console.log(`[idle] nothing for ${idleMs / 60_000} min, stopping; the next request starts the machine`);
    void shutdown("idle");
  }, 60_000).unref();
}

// The widget on a sandbox's preview still says data-site="<site>": route its
// calls to the sandbox, so a preview can never edit the live site.
app.use((req, _res, next) => {
  const sb = sandboxForOrigin(req.header("origin"));
  if (sb) {
    req.url = req.url.replace(`/sites/${sb.parent}/`, `/sites/${sb.id}/`);
    if (req.query.siteId === sb.parent) req.query.siteId = sb.id;
  }
  next();
});
app.use(express.json({ limit: "1mb" })); // attachments go via multipart, so 1mb is plenty
// A body that isn't valid JSON is a 400 in JSON (express's default is an HTML page).
app.use((err: Error, _req: Request, res: Response, next: (e?: unknown) => void) => {
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: "body must be valid JSON" });
    return;
  }
  next(err);
});

const authed = requireOwner();
const authedOrGoogle = requireOwnerOrGoogle();

// ─── per-user site/path scoping (see auth.ts UserScope) ─────────────────────
function authedUser(req: Request): AuthedUser | undefined {
  return (req as Request & { user?: AuthedUser }).user;
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
    .replaceAll("__AK_AGENT_TAGS__", AGENT_TAGS)
    .replaceAll("__AK_RECOVER_URL__", process.env.AK_RECOVER_URL ?? "");
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
  res.setHeader("Content-Type", "text/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
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
  h1 .k{margin-right:10px;vertical-align:-3px}
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
  <h1><img class="k" src="https://agentkeyboard.com/typewriter-mark.png" width="41" height="22" alt="">Agent Keyboard</h1>
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

// The notes editor (Milkdown) — a separate bundle the widget lazy-loads only
// when the owner opens Notes, so widget.js stays small. Public, like widget.js.
app.get("/notes.js", (_req, res) => {
  const p = ["/app/widget/notes.js", join(SERVER_DIR, "..", "widget", "dist", "notes.js")].find((f) => existsSync(f));
  if (!p) {
    res.status(404).type("text/plain").send("// notes.js is not built yet");
    return;
  }
  res.setHeader("Content-Type", "text/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(p);
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
  res.setHeader("Content-Type", "text/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
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
// An <img> sends no Origin, so on a sandbox preview the request still names the
// live site: fall back to that site's open sandboxes (the uuid picks the right one).
app.get("/sites/:siteId/assets/:name", async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  const name = String(req.params.name ?? "");
  const ids = site ? [site.id, ...(await listSandboxes(site.id)).map((sb) => `${site.id}--sb-${sb.name}`)] : [];
  const abs = ids.map((id) => outputPath(id, name)).find((p) => p && existsSync(p));
  if (!abs) {
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
    priority: 0, // priority is live-queue state only; not persisted to the row
    kind: row.kind,
    status: row.status,
    status_line: withBrowserStatus(row.site_id, row.status_line ?? {}),
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

// The todo page's data file, writable without a browser: the Instinct agent PUTs
// the whole file with a Supabase access token and we commit + push it. Owner
// Bearer only (`authed`, not authedOrGoogle) — Google viewers are read-only.
// Deliberately narrow: one site, one path, no path input from the caller.
app.post("/sites/cv/todo-data", authed, async (req, res) => {
  const site = getSite("cv");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  if (denySite(req, res, site.id)) return;
  const body = req.body as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    res.status(400).json({ error: "body must be a JSON object" });
    return;
  }
  // Non-blocking: an agent job can hold this checkout for a long time, and a
  // request that hangs for minutes is worse than one that says "retry".
  const release = tryAcquireSiteLock(site.id);
  if (!release) {
    res.status(409).json({ error: "cv is busy (an agent job holds the checkout) — retry shortly" });
    return;
  }
  try {
    const { headSha, changed } = await commitFile(
      site,
      "todo/data.json",
      // Compact + trailing newline is exactly the shape todo/data.json already
      // has, so an unchanged payload rewrites the same bytes and commits nothing.
      `${JSON.stringify(body)}\n`,
      "todo: update via api",
    );
    res.json({ ok: true, commit_sha: headSha, changed });
  } catch (e) {
    console.error("[todo-data] write failed", e);
    res.status(500).json({ error: String((e as Error)?.message ?? e).slice(0, 300) });
  } finally {
    release();
  }
});

// Long-lived agent keys (see auth.ts). Minting needs a real sign-in, so a key
// (or the internal/relay secrets) can't mint more keys. The key is returned once.
app.post("/agent-keys", authed, async (req, res) => {
  const user = authedUser(req);
  if (!user || user.agentKey || user.id === "internal" || user.id === "relay") {
    res.status(403).json({ error: "sign in with a user session to mint agent keys" });
    return;
  }
  const label = String(req.body?.label ?? "").trim().slice(0, 64);
  if (!label) {
    res.status(400).json({ error: "label required" });
    return;
  }
  const { key, record } = await mintAgentKey(user, label);
  res.status(201).json({ key, id: record.id, label: record.label, createdAt: record.createdAt });
});
app.get("/agent-keys", authed, async (req, res) => {
  const email = authedUser(req)?.email.toLowerCase();
  res.json(
    (await listAgentKeys())
      .filter((k) => k.email.toLowerCase() === email)
      .map(({ id, label, createdAt }) => ({ id, label, createdAt })),
  );
});
app.delete("/agent-keys/:id", authed, async (req, res) => {
  const user = authedUser(req);
  if (!user || !(await revokeAgentKey(user, req.params.id ?? ""))) {
    res.status(404).json({ error: "no such key" });
    return;
  }
  res.json({ revoked: true });
});

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
  const closed = closedReason(getSandbox(site.id));
  if (closed) {
    res.status(410).json({ error: `This sandbox ${closed} — continue at https://${site.sandboxOf!.domain}/` });
    return;
  }
  const body = (req.body ?? {}) as {
    text?: unknown;
    page?: unknown;
    idemKey?: unknown;
    attachmentIds?: unknown;
    priority?: unknown;
    cron?: unknown;
    freshCron?: unknown;
    forceFresh?: unknown;
  };
  const text = typeof body.text === "string" ? body.text : "";
  const page = typeof body.page === "string" ? body.page : "/";
  const idemKey = typeof body.idemKey === "string" && body.idemKey ? body.idemKey : "";
  // Priority lane: higher numbers jump the queue when a worker slot frees.
  // Omitted/invalid = 0 = legacy FIFO behavior for existing clients.
  const priority =
    typeof body.priority === "number" && Number.isFinite(body.priority) ? Math.trunc(body.priority) : 0;
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
  const promptText = text + notesNote(site.id, text) + pathScopeNote(authedUser(req), site.id);
  const internal = authedUser(req)?.id === "internal";
  const sender = internal && typeof (body as { sender?: unknown }).sender === "string" ? String((body as { sender?: unknown }).sender) : authedUser(req)?.email;
  if (sender) lastSender.set(site.id, sender);
  const cron = internal && body.cron === true;
  const freshCron = cron && body.freshCron === true;
  const forceFresh = freshCron ? "fresh cron" : internal && body.forceFresh === true ? "boot requeue" : undefined;
  // Record which Claude session this job drives, so an auto-resume after a
  // self-triggered redeploy can validate its lineage before a fresh handoff.
  const conversationId = await conversationIdFor(site.id, pageSlug);
  const sessionId = sessionIdFor(conversationId);
  const job = await startJob({
    siteId: site.id,
    prompt: text,
    page,
    pageSlug,
    // Built at admission, not at submit: the generator immediately takes the
    // scheduler-held site lock instead of queueing on it with a slot in hand.
    makeGen: (preLock) =>
      input
        ? runStreamingSession(site, { text: promptText, page, pageSlug, attachmentPaths, sender, preLock, cron, freshCron, forceFresh }, input, ac.signal)
        : runMessageJob(site, { text: promptText, page, pageSlug, attachmentPaths, sender, preLock, cron, freshCron, forceFresh }, ac.signal),
    abort: () => ac.abort(),
    idemKey: idemKey || undefined,
    priority,
    streaming: !!input,
    input,
    mcp: mcpFor(sender, cron),
    teammate: isTeammate(sender),
    conversationId,
    sessionId,
    resumeCount: 0,
    sender: cron ? "cron" : sender,
  });
  await streamJobTail(req, res, job);
});

/**
 * Create a sandbox of a live site (the agent calls this with the internal secret).
 * Pushes `ak/<slug>`, waits for its preview to deploy, starts `task` there in a
 * fork of the caller's conversation, and redirects the caller's bar to the
 * preview when its current turn ends. Responds once the preview is live.
 */
app.post("/sites/:siteId/sandboxes", authed, async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  if (denySite(req, res, site.id)) return;
  if (!site.sandbox || site.sandboxOf) {
    res.status(400).json({ error: site.sandboxOf ? "already in a sandbox" : "sandboxes are not enabled for this site (SITES sandbox)" });
    return;
  }
  const body = (req.body ?? {}) as { name?: unknown; task?: unknown; page?: unknown; sender?: unknown };
  const user = authedUser(req);
  const internal = user?.id === "internal";
  const sender = internal ? (typeof body.sender === "string" ? body.sender : undefined) : user?.email;
  const page = typeof body.page === "string" ? body.page : "/";
  const pageSlug = pageSlugFor(site, page);
  const parentSession = sessionIdFor(await conversationIdFor(site.id, pageSlug));
  try {
    const sb = await createSandbox(site, typeof body.name === "string" ? body.name : "", {
      forkFrom: sessionFileExists(checkoutPath(site.id), parentSession) ? parentSession : undefined,
      createdBy: sender,
    });
    const ready = await waitForPreview(sb.url);
    const task = typeof body.task === "string" ? body.task.trim() : "";
    if (task && process.env.AK_INTERNAL_SECRET) {
      const r = await fetch(`http://127.0.0.1:${process.env.PORT ?? 8080}/sites/${sb.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-ak-internal": process.env.AK_INTERNAL_SECRET },
        body: JSON.stringify({ text: task, page: "/", sender }),
      });
      await r.body?.cancel(); // durable job — don't hold its stream open
    }
    setSandboxRedirect(site.id, pageSlug, sb.url);
    res.json({ siteId: sb.id, branch: sb.branch, url: sb.url, ready, forked: !!sb.forkFrom });
  } catch (e) {
    res.status(500).json({ error: `sandbox failed: ${String((e as Error)?.message ?? e).slice(0, 300)}` });
  }
});

/** A live site's open sandboxes, for the bar's switcher (empty inside a sandbox). */
/** The site's events after `after` (Notes spec 21); `wait` (0–50 s) long-polls for the next one.
 *  Owners, the internal secret and the Cloud relay only: events carry asks and replies. */
function eventsSite(req: Request, res: Response) {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return null;
  }
  if (denySite(req, res, site.id)) return null;
  const user = authedUser(req);
  if (!user || !(user.id === "internal" || user.id === "relay" || isOwnerEmail(user.email))) {
    res.status(403).json({ error: "only the site's owner can use its events and webhooks" });
    return null;
  }
  return site;
}
app.get("/sites/:siteId/events", authed, async (req, res) => {
  const site = eventsSite(req, res);
  if (!site) return;
  const wait = Math.max(0, Math.min(50, Number(req.query.wait) || 0));
  res.json(await readEvents(site.id, String(req.query.after ?? ""), wait));
});
/** Add or remove one webhook (`{url, events?, remove?}`); a new hook's secret is returned once. */
app.post("/sites/:siteId/webhooks", authed, async (req, res) => {
  const site = eventsSite(req, res);
  if (!site) return;
  const { url, events, remove } = (req.body ?? {}) as { url?: unknown; events?: unknown; remove?: unknown };
  if (typeof url !== "string" || !url) {
    res.status(400).json({ error: "url required" });
    return;
  }
  const out = await setWebhook(site.id, url, Array.isArray(events) && events.length ? events.map(String) : ["*"], remove === true);
  res.status(out.error ? 400 : 200).json(out);
});

app.get("/sites/:siteId/sandboxes", authed, async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  if (denySite(req, res, site.id)) return;
  // Inside a sandbox: which one this is, and where live is (the menu's "Back to live").
  if (site.sandboxOf) {
    res.json({ sandboxes: [], current: { name: site.id.split("--sb-")[1], liveUrl: `https://${site.sandboxOf.domain}` } });
    return;
  }
  res.json({ sandboxes: site.sandbox ? await listSandboxes(site.id) : [] });
});

// Who sent each site's latest message, so publishing knows who tapped
// "Publish to live" without trusting the agent to say.
const lastSender = new Map<string, string>();

/**
 * Publish a sandbox to live (its agent calls this, with the internal secret,
 * once the user taps "Publish to live"). Only the sandbox's creator or a site
 * owner may. Merges via a PR (see publishSandbox), leaves a note in the live
 * conversation, sends the bar back to live when this turn ends, and deletes the
 * sandbox's checkout once its session lets go of it.
 */
app.post("/sites/:siteId/publish", authed, async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  const sb = getSandbox(req.params.siteId ?? "");
  if (!site?.sandboxOf || !sb) {
    res.status(404).json({ error: "not a sandbox" });
    return;
  }
  if (denySite(req, res, site.id)) return;
  if (sb.publishedAt) {
    res.status(409).json({ error: `already published: ${sb.pr}` });
    return;
  }
  const user = authedUser(req);
  const by = user?.id === "internal" ? lastSender.get(site.id) : user?.email;
  if (!by || !(by === sb.createdBy || isOwnerEmail(by))) {
    res.status(403).json({ error: `only the sandbox's creator (${sb.createdBy ?? "unknown"}) or the site owner can publish it` });
    return;
  }
  const { title, summary } = (req.body ?? {}) as { title?: unknown; summary?: unknown };
  if (typeof title !== "string" || !title.trim()) {
    res.status(400).json({ error: "title required" });
    return;
  }
  try {
    const out = await publishSandbox(site, by, title.trim(), typeof summary === "string" ? summary.trim() : "");
    const live = site.sandboxOf;
    const text =
      `Published the sandbox ${sb.branch} to live: ${title.trim()} (${out.pr})` +
      (out.conflicts.length
        ? `. These notes changed on both sides and kept live's copy: ${out.conflicts.join(", ")}. The sandbox's versions are in .tmp/notes-archive/${sb.id.split("--sb-")[1]}/.`
        : "");
    // A real turn on live (not just a transcript note), so its agent picks the
    // change up and answers without anyone having to nudge it.
    const sent = process.env.AK_INTERNAL_SECRET
      ? await fetch(`http://127.0.0.1:${process.env.PORT ?? 8080}/sites/${live.id}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-ak-internal": process.env.AK_INTERNAL_SECRET },
          body: JSON.stringify({
            text: `${text}\n[Published] This sandbox's work is now on live. Briefly confirm it's in (check it deployed if you can) and say what changed.`,
            page: "/",
            sender: by,
          }),
        })
          .then(async (r) => (await r.body?.cancel(), r.ok))
          .catch(() => false)
      : false;
    if (!sent)
      await addTeamNote(live.id, await conversationIdFor(live.id, ""), {
        id: randomUUID(),
        role: "user",
        text,
        tools: [],
        ts: new Date().toISOString(),
        sender: by,
      }).catch(() => {});
    setSandboxRedirect(site.id, pageSlugFor(site, "/"), `https://${live.domain}/`);
    void acquireSiteLock(site.id).then((release) => removeCheckout(site.id).catch(() => {}).finally(release));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: `publish failed: ${String((e as Error)?.message ?? e).slice(0, 400)}` });
  }
});

/** Archive a sandbox without publishing (creator or owner; internal callers name the `sender`). */
app.post("/sites/:siteId/archive", authed, async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  const sb = getSandbox(req.params.siteId ?? "");
  if (!site?.sandboxOf || !sb) {
    res.status(404).json({ error: "not a sandbox" });
    return;
  }
  if (denySite(req, res, site.id)) return;
  if (closedReason(sb)) {
    res.status(409).json({ error: `already closed: it ${closedReason(sb)}` });
    return;
  }
  const user = authedUser(req);
  const sender = (req.body as { sender?: unknown } | undefined)?.sender;
  const by = user?.id === "internal" ? (typeof sender === "string" ? sender : undefined) : user?.email;
  if (!by || !(by === sb.createdBy || isOwnerEmail(by))) {
    res.status(403).json({ error: `only the sandbox's creator (${sb.createdBy ?? "unknown"}) or the site owner can archive it` });
    return;
  }
  await archiveSandbox(site, by);
  void acquireSiteLock(site.id).then((release) => removeCheckout(site.id).catch(() => {}).finally(release));
  res.json({ archived: sb.id });
});

// ─── moving a site's context to another instance (Notes spec 19, migrate.ts) ──
/** The owner approves sending one site's notes, memory and settings to `return`
 *  (the managed control plane's callback), which gets a single-use export token. */
app.get("/export-consent", async (req, res) => {
  const js = (v: string) => JSON.stringify(v).replace(/</g, "\\u003c");
  const site = getSite(String(req.query.site ?? ""));
  let to: URL | null = null;
  try {
    to = new URL(String(req.query.return ?? ""));
  } catch {}
  if (!site || site.sandboxOf || !to || !(to.protocol === "https:" || to.hostname === "localhost")) {
    res.status(400).type("text").send("This link needs ?site=<a site on this server>&return=<an https URL>.");
    return;
  }
  const esc = (v: string) => v.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  // One tap: the site's own bar is usually signed in already, so approve there (#ak_export,
  // widget/src/index.ts; it comes back here with ?form=1 when it isn't). Only if the site is up
  // and its page carries the bar; otherwise sign in on this page.
  const page = req.query.form || !site.domain ? "" : await fetch(`https://${site.domain}/`, { signal: AbortSignal.timeout(5000) }).then((r) => (r.ok ? r.text() : ""), () => "");
  if (page.includes("widget.js") && page.includes(site.id)) {
    const bar = `https://${site.domain}/#ak_export=${encodeURIComponent(to.href)}`;
    res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=${esc(bar)}">
<title>Agent Keyboard — move ${esc(site.id)}</title><p style="font:14px ui-monospace,monospace">Opening <a href="${esc(bar)}">${esc(site.domain)}</a>…</p>`);
    return;
  }
  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Agent Keyboard — move ${esc(site.id)}</title>
<style>
  :root{--bg:#0a0a0a;--ink:#f5f1ea;--ink2:#b8b2a7;--ink3:#6f6a61;--rule:#211f1c;--amber:#ffb86b;--err:#f97066}
  html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
  main{max-width:440px;margin:16vh auto 0;padding:0 20px}
  h1{font-size:17px;font-weight:600;margin:0 0 6px}
  p{color:var(--ink2);margin:0 0 18px;font-size:13.5px} b{color:var(--ink)}
  label{display:block;color:var(--ink3);font-size:11px;letter-spacing:.06em;margin:14px 0 4px}
  input{width:100%;box-sizing:border-box;background:transparent;border:none;border-bottom:1px solid var(--rule);color:var(--ink);font:inherit;padding:6px 2px;outline:none}
  input:focus{border-bottom-color:var(--amber)}
  .opt{display:flex;gap:8px;align-items:center;color:var(--ink2);font-size:12.5px;letter-spacing:0;margin:12px 0 0}
  .opt input{width:auto;accent-color:var(--amber)}
  pre{white-space:pre-wrap;color:var(--ink2);font:12.5px/1.6 inherit;border-top:1px solid var(--rule);padding-top:12px;margin:18px 0 0}
  button{margin-top:22px;background:var(--amber);color:#141310;border:none;border-radius:8px;padding:10px 18px;font:600 13.5px ui-monospace,monospace;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  .msg{margin-top:16px;font-size:13px;min-height:1.4em;color:var(--err)}
</style></head>
<body><main>
  <h1>Move ${esc(site.id)}</h1>
  <p>Send this site's notes, memory and settings to <b>${esc(to.host)}</b>? Only approve if you started this move.</p>
  <form id="f">
    <label for="em">email</label><input id="em" type="email" autocomplete="username" required>
    <label for="pw">password</label><input id="pw" type="password" autocomplete="current-password" required>
    <pre id="dry" hidden></pre><div id="opts"></div>
    <button id="go" type="submit">Sign in</button>
  </form>
  <div class="msg" id="msg" role="alert"></div>
<script>
  const SB = ${js(process.env.SUPABASE_URL ?? "")}, ANON = ${js(process.env.SUPABASE_ANON_KEY ?? "")}, SITE = ${js(site.id)}, RET = ${js(to.href)};
  const msg = (t) => (document.getElementById("msg").textContent = t);
  const BASE = location.origin + location.pathname.replace(/\\/export-consent$/, ""); // this server, even under a path prefix
  let s = null; // signed in: step 2 shows the dry run, then approves
  document.getElementById("f").addEventListener("submit", async (e) => {
    e.preventDefault();
    const go = document.getElementById("go"); go.disabled = true; msg("");
    try {
      if (!s) {
        s = await fetch(SB.replace(/\\/$/, "") + "/auth/v1/token?grant_type=password", {
          method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
          body: JSON.stringify({ email: document.getElementById("em").value.trim(), password: document.getElementById("pw").value }),
        }).then((r) => r.json());
        if (!s.access_token) { const m = s.error_description || s.msg; s = null; throw new Error(m || "Wrong email or password."); }
        const p = await fetch(BASE + "/sites/" + encodeURIComponent(SITE) + "/export-preview", { headers: { Authorization: "Bearer " + s.access_token } });
        const d = await p.json().catch(() => ({}));
        if (!p.ok) { s = null; throw new Error(d.error || "Not allowed (" + p.status + ")."); }
        const dry = document.getElementById("dry"); dry.textContent = d.summary; dry.hidden = false;
        for (const o of d.opts) {
          const l = document.createElement("label"), c = document.createElement("input");
          l.className = "opt"; c.type = "checkbox"; c.dataset.key = o.key; l.append(c, " " + o.ask);
          document.getElementById("opts").append(l);
        }
        for (const id of ["em", "pw"]) document.getElementById(id).disabled = true;
        go.textContent = "Approve the move"; go.disabled = false;
        return;
      }
      const body = Object.fromEntries([...document.querySelectorAll("#opts input")].map((c) => [c.dataset.key, c.checked]));
      const r = await fetch(BASE + "/sites/" + encodeURIComponent(SITE) + "/export-token", { method: "POST", headers: { Authorization: "Bearer " + s.access_token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || "Not allowed (" + r.status + ").");
      const u = new URL(RET);
      u.searchParams.set("token", out.token); u.searchParams.set("origin", BASE); u.searchParams.set("site", SITE);
      location.href = u.href;
    } catch (err) { msg(err.message || "Network error, try again."); go.disabled = false; }
  });
</script>
</main></body></html>`);
});

/** The site and its mover (the consent page, signed in as someone allowed on the site), or null after answering. */
function moverOf(req: express.Request, res: express.Response) {
  const site = getSite(req.params.siteId ?? "");
  const user = authedUser(req);
  if (!site || site.sandboxOf) {
    res.status(404).json({ error: "unknown site" });
    return null;
  }
  if (denySite(req, res, site.id)) return null;
  if (!user?.email || user.id === "internal" || user.id === "relay" || user.scope?.pathPrefix || user.scope?.paths?.[site.id]) {
    res.status(403).json({ error: "only the site's owner can move it" });
    return null;
  }
  return { site, user: user as typeof user & { email: string } };
}

/** The dry run shown before approving: what moves, what stays, what to redo, and which opt-ins to ask. */
app.get("/sites/:siteId/export-preview", authed, async (req, res) => {
  const m = moverOf(req, res);
  if (!m) return;
  const to = String(req.query.to ?? "");
  const p = await exportPreview(m.site, isOwnerEmail(m.user.email));
  // The bar's one-tap approval shows this as is; the password page has its own heading.
  if (/^[a-z0-9.-]+(:\d+)?$/i.test(to)) p.summary = `Move ${m.site.id} to ${to}? Only if you started this move.\n\n${p.summary}`;
  res.json(p);
});

/** Mint the single-use export token. */
app.post("/sites/:siteId/export-token", authed, (req, res) => {
  const m = moverOf(req, res);
  if (!m) return;
  const { site, user } = m;
  const owner = isOwnerEmail(user.email), b = (req.body ?? {}) as Record<string, unknown>;
  const keys = b.keys === true || req.query.keys === "1", files = b.files === true || req.query.files === "1"; // the password page posts JSON, the bar a query
  // Skills are instance-wide; env values and working files are this site's, opt-in (spec 20).
  res.json({ token: mintExportToken(site.id, { skills: owner && !site.guest, keys: keys === true && (owner || !site.guest), files: files === true && (owner || !site.guest) }) });
});

/** The bundle (tar.gz), for the holder of an export token for this site. */
app.get("/sites/:siteId/export", async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  const ok = site && redeemExportToken(req.header("x-ak-export") ?? "", site.id);
  if (!site || !ok) {
    res.status(401).json({ error: "export token missing, used or expired" });
    return;
  }
  await streamExport(site, ok, req.header("x-ak-export-key") ?? "", res).catch((e) => {
    console.error("[export]", site.id, e);
    if (!res.headersSent) res.status(500).json({ error: "export failed" });
    else res.destroy();
  });
});

/** Pull another instance's bundle into this site (internal secret: the control plane, before the first message). */
app.post("/sites/:siteId/import", authed, async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site || site.sandboxOf) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  if (authedUser(req)?.id !== "internal") {
    res.status(403).json({ error: "internal only" });
    return;
  }
  const { origin, site: from, token, bearer } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof origin !== "string" || typeof from !== "string" || (typeof token !== "string" && typeof bearer !== "string")) {
    res.status(400).json({ error: "origin, site and token (or bearer) required" });
    return;
  }
  const release = await acquireSiteLock(site.id);
  try {
    await ensureCheckout(site);
    res.json(await importFrom(site, origin, from, { token: typeof token === "string" ? token : undefined, bearer: typeof bearer === "string" ? bearer : undefined }));
  } catch (e) {
    const status = (e as { status?: number }).status;
    res.status(status === 404 ? 404 : 502).json({ error: String((e as Error)?.message ?? e).slice(0, 300) });
  } finally {
    release();
  }
});

/**
 * Sign-in handoff to a sandbox preview on another domain: a single-use magic-link
 * token for the caller (GoTrue admin API). The widget redirects to
 * `<preview>#ak_handoff=<token_hash>`, where the bar redeems it for its own session.
 */
app.post("/auth/handoff", authed, async (req, res) => {
  const user = authedUser(req);
  const key = process.env.SUPABASE_SERVICE_KEY ?? "";
  if (!user?.email || user.agentKey || ["internal", "relay"].includes(user.id) || !key) {
    res.status(400).json({ error: "handoff needs a signed-in user and SUPABASE_SERVICE_KEY" });
    return;
  }
  const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", email: user.email }),
  }).catch(() => null);
  const data = (await r?.json().catch(() => null)) as { hashed_token?: string; properties?: { hashed_token?: string } } | null;
  const token = data?.hashed_token ?? data?.properties?.hashed_token;
  if (!token) {
    res.status(502).json({ error: "couldn't mint a handoff token" });
    return;
  }
  res.json({ token_hash: token });
});

/** Inject a follow-up message into a running streaming session (M2). 404/409 if
 *  the site is unknown or the job isn't an open streaming session. */
app.post("/sites/:siteId/jobs/:jobId/messages", authed, async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  if (denySite(req, res, site.id)) return;
  const body = (req.body ?? {}) as { text?: unknown; attachmentIds?: unknown };
  const text = typeof body.text === "string" ? body.text : "";
  const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : [];
  if (!text.trim() && attachmentIds.length === 0) {
    res.status(400).json({ error: "text or attachmentIds required" });
    return;
  }
  // The job must belong to the site in the URL — otherwise the site check
  // above could be sidestepped by posting another site's jobId under this one.
  const target = getJob(req.params.jobId ?? "");
  // A session spawned with the Agent Keyboard MCP (an owner's turn) never takes a
  // teammate's message, nor the reverse; same for one spawned with the owner's
  // secrets (OWNER_ENV). The bar queues it for a fresh session.
  if (!target || target.siteId !== site.id || target.mcp !== mcpFor(authedUser(req)?.email) || !!target.teammate !== isTeammate(authedUser(req)?.email)) {
    res.status(409).json({ error: "job not accepting messages" });
    return;
  }
  // Follow-ups get the same "[Sent from … by <email>]" header as opening turns so
  // the transcript can attribute them; the page is unknown here, "/" is fine.
  const user = authedUser(req);
  if (user?.email) lastSender.set(site.id, user.email);
  const attachmentPaths = attachmentIds.length ? await resolveAttachments(site.id, attachmentIds) : [];
  const ok = appendToJob(
    req.params.jobId ?? "",
    buildPrompt(site, { text: text + notesNote(site.id, text) + pathScopeNote(user, site.id), page: "/", attachmentPaths, sender: user?.email }),
    { ask: text, sender: user?.email },
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

// ─── notes (the bar's full-screen markdown editor; see notes.ts) ─────────────
app.get("/sites/:siteId/notes", authed, async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  if (denySite(req, res, site.id)) return;
  res.json(await listNotes(site.id));
});

/** The sidebar layout: note names and one level of {folder, notes} (see notes.ts). */
app.get("/sites/:siteId/notes-order", authed, async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  if (denySite(req, res, site.id)) return;
  res.json(await noteTree(site.id));
});

/** Save the sidebar layout (body {names}: the same shape GET returns), set by
 *  dragging notes and folders, and by creating or renaming folders. */
app.put("/sites/:siteId/notes-order", authed, async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  if (denySite(req, res, site.id)) return;
  const { names } = (req.body ?? {}) as { names?: unknown };
  if (!validOrder(names)) {
    res.status(400).json({ error: "invalid note order" });
    return;
  }
  await ensureCheckout(site);
  await writeOrder(site.id, names);
  res.json({ ok: true });
});

app.get("/sites/:siteId/notes/:name", authed, async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  if (denySite(req, res, site.id)) return;
  const name = req.params.name;
  const content = validNoteName(name) ? await readNote(site.id, name) : null;
  if (content === null) {
    res.status(404).json({ error: "no such note" });
    return;
  }
  res.json({ name, content, meta: await noteMeta(site.id, name!) });
});

/** Save a note (body {content, from?}); `from` renames that note to :name first. */
app.put("/sites/:siteId/notes/:name", authed, async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  if (denySite(req, res, site.id)) return;
  const { content, from } = (req.body ?? {}) as { content?: unknown; from?: unknown };
  const name = req.params.name;
  if (!validNoteName(name) || typeof content !== "string" || (from !== undefined && !validNoteName(from))) {
    res.status(400).json({ error: "invalid note name or content" });
    return;
  }
  await ensureCheckout(site);
  if (!(await writeNote(site.id, name, content, from, authedUser(req)?.email))) {
    res.status(409).json({ error: "a note or folder with that name already exists" });
    return;
  }
  res.json({ name });
});

app.delete("/sites/:siteId/notes/:name", authed, async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  if (denySite(req, res, site.id)) return;
  const name = req.params.name;
  if (!validNoteName(name)) {
    res.status(400).json({ error: "invalid note name" });
    return;
  }
  await deleteNote(site.id, name);
  res.json({ name });
});

/** Upload an image into the notes (raw body, Content-Type png/jpeg/gif/webp, ≤10 MB);
 *  returns {path} — "images/<uuid>.<ext>", what the note's markdown keeps. */
app.post("/sites/:siteId/notes-images", authed, express.raw({ type: () => true, limit: "10mb" }), async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  if (denySite(req, res, site.id)) return;
  const mime = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (!NOTE_IMAGE_TYPES[mime] || !Buffer.isBuffer(req.body) || !req.body.length) {
    res.status(400).json({ error: "send a PNG, JPEG, GIF or WebP image" });
    return;
  }
  await ensureCheckout(site);
  res.json({ path: await saveNoteImage(site.id, mime, req.body) });
});

app.get("/sites/:siteId/notes-images/:file", authed, (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  if (denySite(req, res, site.id)) return;
  const file = req.params.file;
  if (!validNoteImage(file) || !existsSync(noteImagePath(site.id, file))) {
    res.status(404).json({ error: "no such image" });
    return;
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.sendFile(noteImagePath(site.id, file));
});

// ─── teammate notes (an @mention in the composer; see team.ts) ───────────────
app.get("/sites/:siteId/teammates", authed, async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  if (denySite(req, res, site.id)) return;
  res.json((await siteMembers(site.id)).map((email) => ({ email, handle: handleOf(email), canEmail: !!process.env.RESEND_API_KEY })));
});

/** Leave a note for the people (you included) @mentioned in `text`: saved to the transcript,
 *  and emailed only if `notify` — no Claude turn. 400 if it mentions nobody on the site. */
app.post("/sites/:siteId/teamnotes", authed, async (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  if (denySite(req, res, site.id)) return;
  const { text, page, notify } = (req.body ?? {}) as { text?: unknown; page?: unknown; notify?: unknown };
  const from = authedUser(req)?.email ?? "";
  const mentioned = new Set(typeof text === "string" ? [...text.matchAll(/(?:^|\s)@([\w.+-]+)/g)].map((m) => m[1]!.toLowerCase()) : []);
  const to = (await siteMembers(site.id)).filter((e) => mentioned.has(handleOf(e)) || mentioned.has(e));
  if (typeof text !== "string" || !text.trim() || text.length > 10_000 || !to.length) {
    res.status(400).json({ error: "mention a teammate with @name" });
    return;
  }
  const path = typeof page === "string" && page.startsWith("/") ? page : "/";
  const conversationId = await conversationIdFor(site.id, pageSlugFor(site, path));
  const note = { id: randomUUID(), role: "user" as const, text: text.trim(), tools: [], ts: new Date().toISOString(), sender: from, to };
  if (notify === true) {
    try {
      const { messages } = await readConversation(site.id, { limit: 5, pageSlug: pageSlugFor(site, path) });
      const publicUrl = process.env.AK_PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
      await emailMention({ site, from, to, text: note.text, url: `https://${site.domain}${path}`, excerpt: messages, publicUrl });
    } catch (err) {
      console.error("[teamnotes] email failed", err);
      res.status(502).json({ error: "couldn't send the email — note not saved" });
      return;
    }
  }
  await addTeamNote(site.id, conversationId, note);
  res.json(note);
});

// A mention email's button: count the click only once this page's script runs
// (link scanners fetch without running JS), then go to the chat.
app.get("/n/:id", (req, res) => {
  const url = noticeUrl(req.params.id ?? "");
  if (!url) {
    res.status(404).type("text").send("This link has expired.");
    return;
  }
  const js = (v: string) => JSON.stringify(v).replace(/</g, "\\u003c");
  res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Opening the chat…</title>
<body style="margin:0;background:#0a0a0a;color:#b8b2a7;font:15px -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;display:grid;place-items:center;min-height:100vh">
<p>Opening the chat… <a href="${url.replace(/"/g, "&quot;")}" style="color:#ffb86b">continue</a></p>
<script>fetch(location.pathname,{method:"POST",keepalive:true}).finally(function(){location.replace(${js(url)})})</script>`);
});
app.post("/n/:id", (req, res) => {
  markClicked(req.params.id ?? "").catch((err) => console.error("[notice] click follow-up failed", err));
  res.status(204).end();
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
  const active = listActive(site.id, pageSlug).filter(
    (job) => job.status === "queued" || job.status === "running",
  );
  for (const job of active) cancelJob(job.job_id);

  let release: (() => void) | undefined;
  try {
    release = await acquireSiteLock(site.id);
    const reset = pageSlug === "" ? await resetCheckoutToOrigin(site) : null;
    const conversationId = await rotateConversation(site.id, pageSlug);
    res.json({
      ok: true,
      cancelled: active.length,
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
  for (const job of listActive(site.id, pageSlug)) {
    if (job.status === "queued" || job.status === "running") cancelJob(job.job_id);
  }
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
  if (row.status_line) writeFrame(res, "status", withBrowserStatus(row.site_id, row.status_line));
  if (row.status === "done") {
    // A done streaming session's stored result is its last TURN payload
    // (open: true). Replaying that verbatim makes the widget re-open the
    // session and reconnect forever — the session is over, so say so.
    if ((row.result as { open?: unknown } | null)?.open === true) writeFrame(res, "closed", {});
    else writeFrame(res, "result", row.result ?? {});
  } else if (row.status === "running" || row.status === "queued") {
    // In the DB but not the registry: the machine restarted mid-job (an orphan
    // the boot sweep hasn't reconciled). Report it honestly.
    writeFrame(res, "error", {
      kind: "interrupted",
      detail: "The server restarted before this job finished.",
    });
  } else {
    writeFrame(res, "error", row.error ?? { kind: "job_failed", detail: "The job failed." });
  }
  res.end();
});

/** View-only live Chromium screencast for one allow-listed site. */
app.get("/sites/:siteId/screen", authedOrGoogle, (req, res) => {
  const site = getSite(req.params.siteId ?? "");
  if (!site) {
    res.status(404).json({ error: "unknown site" });
    return;
  }
  if (denySite(req, res, site.id)) return;
  streamScreen(req, res, site.id);
});

/** List active jobs + a 10-minute finished window for a site (registry ∪ DB). */
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

// GET /check: the instance's self-test (see setup.ts). Public, no secrets in it.
app.use(setupRouter());
// Self-test once after boot, so a broken config shows up in `fly logs` (also at GET /check).
setTimeout(() => void runChecks().then((cs) => {
  for (const c of cs) console.log(`agent-keyboard: check ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
}), 15_000).unref();

// Isolated browser tasks (see browser.ts) — primary-owner-only, one throwaway
// Chromium + profile per task, never the agent's own CDP browsers.
app.use(browserTasksRouter());

// ─── boot + graceful shutdown ────────────────────────────────────────────────
const port = Number(process.env.PORT ?? 8080);
const httpServer = app.listen(port, () => {
  console.log(`agent-keyboard listening on :${port}`);
  startBrowserDetection(
    () => listActive().filter((job) => job.status === "running").map((job) => job.site_id),
    publishBrowserStatus,
  );
  if (process.env.JOBS_CRON_DISABLED !== "1") startJobsCron();
  startIdleStop();
  startCheckoutPruning(SITES);
  // Idle sandboxes: a note in the sandbox's own conversation first, then archived.
  const sandboxPrune = () =>
    void pruneSandboxes(
      (id) => getSite(id),
      async (sb) =>
        addTeamNote(sb.id, await conversationIdFor(sb.id, ""), {
          id: randomUUID(),
          role: "user",
          text: `This sandbox has been idle for 12 days. It will be archived in 2 days (branch deleted, notes kept on live) unless someone sends a message here.`,
          tools: [],
          ts: new Date().toISOString(),
          sender: "Agent Keyboard",
        }),
    ).catch((e) => console.error("[sandbox] prune failed", e));
  sandboxPrune();
  setInterval(sandboxPrune, 6 * 3_600_000).unref();
  setOnHookDisabled(async (siteId, url) =>
    addTeamNote(siteId, await conversationIdFor(siteId, ""), {
      id: randomUUID(),
      role: "user",
      text: `The webhook ${url} failed 20 times in a row, so it was turned off ("disabled": true in settings). Remove that key to turn it back on.`,
      tools: [],
      ts: new Date().toISOString(),
      sender: "Agent Keyboard",
    }).catch(() => {}),
  );
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
    // Only now: run earlier, the continuation's fresh job row raced into the
    // requeue list above and was sent twice (duplicate redeploy messages).
    void resumeAfterRedeploy().catch((e) => console.error("[boot] auto-resume failed", e));
    const secret = process.env.AK_INTERNAL_SECRET ?? "";
    if (!secret) return;
    for (const row of requeue) {
      fetch(`http://127.0.0.1:${port}/sites/${encodeURIComponent(row.site_id)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-ak-internal": secret },
        body: JSON.stringify({
          // A scheduled phase that had already started gets told so: it must
          // crash-recover (Gmail first) rather than assume a clean slate.
          text:
            /^\[scheduled/.test(row.prompt ?? "") && !["", "queued", "syncing"].includes(String(row.status_line?.phase ?? ""))
              ? `[resumed after a server restart at ${new Date().toISOString()} — this phase was already running; crash-recover per the runbook before continuing]\n${row.prompt}`
              : row.prompt,
          page: row.page ?? "/",
          idemKey: `requeue-${row.job_id}`,
          forceFresh: true,
          cron: /^\[scheduled/.test(row.prompt ?? ""),
        }),
      })
        .then(async (r) => {
          void r.body?.cancel();
          console.log(`[boot] requeued ${row.job_id} -> ${row.site_id} (${r.status})`);
          // Tag the old row so a later boot never rescues it a second time.
          if (r.ok) await markRequeued(row.job_id).catch(() => {});
        })
        .catch((e) => console.error(`[boot] requeue ${row.job_id} failed`, String(e)));
    }
  })().catch((e) => console.error("[boot] job sweep failed", e));
  try {
    keepTranscripts();
  } catch (e) {
    console.error("[boot] could not set transcript retention", e);
  }
  void seedSkills().catch((e) => console.error("[boot] skill seed failed", e));
  void seedCodexConfig().catch((e) => console.error("[boot] codex config seed failed", e));
  // "Update yourself" pushes to the fork: warn now, not mid-request, if GH_TOKEN can't.
  // The receive-pack handshake is 200 only with push access, and writes nothing.
  const fork = process.env.AK_FORK_REPO;
  if (fork) {
    void fetch(`https://github.com/${fork}.git/info/refs?service=git-receive-pack`, {
      headers: { Authorization: `Basic ${Buffer.from(`x-access-token:${process.env.GH_TOKEN ?? ""}`).toString("base64")}` },
    })
      .then((r) => {
        if (!r.ok) console.warn(`agent-keyboard: GH_TOKEN can't push AK_FORK_REPO ${fork} (HTTP ${r.status}), so "update yourself" will fail — add the fork to the token (Repository access, Contents: Read and write)`);
      })
      .catch((e) => console.warn(`agent-keyboard: couldn't check push access to ${fork}`, String(e)));
  } else {
    console.log(`agent-keyboard: AK_FORK_REPO unset — "update yourself" is off; set it to your fork (owner/agent-keyboard) to enable it`);
  }
  startTailscale();
});
// LinkedIn-only residential egress (see tailscale-up.sh): bring up the
// userspace tailscaled + exit node in the background. Best-effort — the script
// no-ops without TS_AUTHKEY, and a failure only means the LinkedIn browsers'
// fail-closed egress gate stays red; it never blocks serving.
function startTailscale(): void {
  const script = process.env.TAILSCALE_UP ?? "/app/tailscale-up.sh";
  if (!existsSync(script)) return;
  const child = spawn("sh", [script], { stdio: ["ignore", "pipe", "pipe"] });
  const log = (s: Buffer) => s.toString().trim().split("\n").forEach((l) => l && console.log(`[tailscale] ${l}`));
  child.stdout.on("data", log);
  child.stderr.on("data", log);
  child.on("exit", (code) => code && console.error(`[tailscale] tailscale-up.sh exited ${code}`));
  child.on("error", (e) => console.error("[tailscale] spawn failed", e));
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} — marking active jobs interrupted, killing children`);
  try {
    writePendingResume(runningResumeInputs());
  } catch {
    /* auto-resume is best-effort; never block shutdown */
  }
  killAllChildren();
  await closeAllBrowserTasks().catch(() => {});
  await interruptRunningJobs().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
