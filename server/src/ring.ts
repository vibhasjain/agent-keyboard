// Ring webhook — the smart ring's phone app POSTs a voice transcription here and
// we hand it to the owner over the WhatsApp bridge. WhatsApp is the ONLY
// channel: an unreachable bridge logs and answers non-2xx, and the phone re-sends
// the note with the next press. The server never emails the owner (owner
// decision 2026-09-03, after intermittent 5s bridge timeouts quietly turned ring
// notes into email). Owner decision (2026-09-01): a ring press is a note to
// self, not a task — this is a dumb pipe and nothing acts on the transcript.
//
// Three properties of the sender shape everything below:
//   1. The upload is async on the phone and a FAILED one is re-sent alongside the
//      NEXT recording. So anything we don't want repeated must answer 2xx — an
//      empty transcription is a 200, not a 400 — and a delivered mail is keyed by
//      recordedAt, so a genuine retry is dropped instead of sent twice.
//   2. The POST is multipart and may carry an m4a of the recording. We never want
//      the audio: the file part is drained and discarded, never buffered.
//   3. Anyone on the internet can reach this route, so the shared secret is
//      checked BEFORE the body is parsed — an unauthenticated caller must not be
//      able to make us read 20MB off the wire.
//
// Focus (/focus, /fleet) is kept for fleet inspection but no longer routes
// anything: every press goes to the bridge, whatever the focus says.

import busboy from "busboy";
import express, { type Request, type Response } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { requireOwner } from "./auth.js";
import { readDataFile, writeDataFile } from "./checkouts.js";

const RING_SECRET = process.env.AK_RING_SECRET ?? "";
const PORT = Number(process.env.PORT ?? 8080);
const FOCUS_FILE = "agent-keyboard/ring-focus.json";
const FOCUS_TTL_MS = 2 * 60 * 60_000;
const MASTER_HANDLE = "home";
const WA_BRIDGE_URL = process.env.WA_BRIDGE_URL ?? "";
const WA_API_TOKEN = process.env.WA_API_TOKEN ?? "";
// The recipient is a personal phone number, so it lives in a Fly secret rather
// than in this (public) repo.
const WA_TO = process.env.RING_WA_TO ?? "";
const WA_TIMEOUT_MS = 5_000;
// A failed upload is re-sent with the NEXT recording; only a delivered note is
// remembered, so a retry after a failure still gets through (process-lifetime).
const delivered = new Set<string>();

function isRingSecret(got: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(RING_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── the fleet registry (server/skills/relay/handles.json) ───────────────────
// Same lookup the widget's agent tags use (index.ts): the baked-in image copy
// first, the repo copy when tsx runs from server/ in dev. Cached for the life of
// the process — the registry only changes on deploy, which restarts us.

interface Instance {
  app: string;
  url: string;
}
interface Handle {
  instance: string;
  site: string;
  page?: string;
}
interface Registry {
  instances: Record<string, Instance | undefined>;
  handles: Record<string, Handle | undefined>;
}

const EMPTY_REGISTRY: Registry = { instances: {}, handles: {} };
let registryCache: Registry | null = null;

function registry(): Registry {
  if (registryCache) return registryCache;
  const paths = [
    join(process.env.SKILLS_SRC_DIR ?? "/app/skills", "relay", "handles.json"),
    join(process.cwd(), "skills", "relay", "handles.json"), // dev: tsx runs from server/
  ];
  for (const p of paths) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<Registry>;
      if (parsed?.handles && parsed.instances) {
        registryCache = { instances: parsed.instances, handles: parsed.handles };
        return registryCache;
      }
    } catch {
      /* try the next path */
    }
  }
  console.error("[ring] no relay handles registry found — ring presses cannot be routed");
  registryCache = EMPTY_REGISTRY;
  return registryCache;
}

/** The WhatsApp bridge — the only delivery channel. Anything other than a 2xx
 *  inside the timeout is a miss: we log it and drop this press (the phone
 *  re-sends the recording alongside the next one). */
async function whatsapp(text: string): Promise<boolean> {
  if (!WA_BRIDGE_URL || !WA_API_TOKEN || !WA_TO) {
    console.error("[ring] whatsapp bridge not configured — dropping this press");
    return false;
  }
  try {
    const res = await fetch(WA_BRIDGE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${WA_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: WA_TO, text }),
      signal: AbortSignal.timeout(WA_TIMEOUT_MS),
    });
    await res.body?.cancel();
    if (!res.ok) console.error(`[ring] whatsapp bridge said ${res.status} ${res.statusText} — dropping this press`);
    return res.ok;
  } catch (err) {
    console.error(`[ring] whatsapp bridge unreachable (${String(err)}) — dropping this press`);
    return false;
  }
}

// ─── focus ───────────────────────────────────────────────────────────────────

interface Focus {
  handle: string;
  at: string;
}

async function readFocus(): Promise<Focus | null> {
  const raw = await readDataFile(FOCUS_FILE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Focus>;
    if (typeof parsed?.handle !== "string" || typeof parsed.at !== "string") return null;
    return { handle: parsed.handle, at: parsed.at };
  } catch {
    return null;
  }
}

/** The handle a ring press goes to right now. An expired focus, or one naming a
 *  handle that has since left the registry, falls back to the master. */
async function effectiveFocus(focus: Focus | null): Promise<string> {
  if (!focus) return MASTER_HANDLE;
  const at = Date.parse(focus.at);
  if (!Number.isFinite(at) || Date.now() - at > FOCUS_TTL_MS) return MASTER_HANDLE;
  return registry().handles[focus.handle] ? focus.handle : MASTER_HANDLE;
}

// ─── routes ──────────────────────────────────────────────────────────────────

export function ringRouter(): express.Router {
  const router = express.Router();
  const authed = requireOwner();
  // The app mounts express.json() globally, but re-declaring it here keeps the
  // router independent of mount order (it no-ops on an already-parsed body).
  const json = express.json({ limit: "64kb" });

  router.post("/ring", (req: Request, res: Response) => {
    if (!RING_SECRET) {
      res.status(503).json({ error: "ring not configured" });
      return;
    }
    // The Pebble app's webhook UI recommends a standard Authorization header,
    // so the secret is accepted either way: x-ring-secret: <s> or
    // Authorization: Bearer <s> (bare <s> also fine).
    const auth = req.header("authorization") ?? "";
    const bearer = auth.replace(/^Bearer\s+/i, "");
    if (!isRingSecret(req.header("x-ring-secret") ?? "") && !isRingSecret(bearer)) {
      res.status(401).json({ error: "not authorized" });
      return;
    }
    if (!/^multipart\/form-data/i.test(req.header("content-type") ?? "")) {
      res.status(400).json({ error: "expected multipart/form-data" });
      return;
    }

    const trigger = req.header("x-index-trigger") ?? "unknown";
    const isTest = (req.header("x-index-test") ?? "").toLowerCase() === "true" || trigger === "test-event";

    const bb = busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: 20 * 1024 * 1024, fields: 10, fieldSize: 64 * 1024 },
    });
    const fields = new Map<string, string>();
    let handled = false;
    const finish = (status: number, payload: unknown): void => {
      if (handled) return;
      handled = true;
      res.status(status).json(payload);
    };

    bb.on("file", (_name, stream) => stream.resume()); // the m4a is never wanted
    bb.on("field", (name, value: string) => fields.set(name, value));
    bb.on("error", (err: unknown) => finish(400, { error: String(err).slice(0, 300) }));
    bb.on("close", () => {
      const transcription = (fields.get("transcription") ?? "").trim();
      const recordedAt = fields.get("recordedAt") ?? "";
      if (isTest || !transcription) {
        console.log(`[ring] trigger=${trigger} routed=${isTest ? "-(test)" : "-(empty)"} len=${transcription.length}`);
        finish(200, isTest ? { ok: true, test: true } : { ok: true, ignored: "empty" });
        return;
      }
      void (async () => {
        console.log(`[ring] trigger=${trigger} len=${transcription.length}`);
        // A retry arrives as the same recordedAt — don't send the same note twice.
        const idemKey = /^\d+$/.test(recordedAt) ? `ring-${recordedAt}` : randomUUID();
        if (delivered.has(idemKey)) {
          finish(200, { ok: true, duplicate: true });
          return;
        }
        if (!(await whatsapp(transcription))) {
          // Non-2xx: the phone re-sends this recording with the next one, so a
          // bridge blip costs a delay, not the note — and never an email.
          finish(502, { error: "whatsapp bridge unavailable" });
          return;
        }
        delivered.add(idemKey);
        console.log("[ring] delivered via whatsapp");
        finish(200, { ok: true, via: "whatsapp" });
      })().catch((err) => finish(500, { error: String(err).slice(0, 300) }));
    });
    req.pipe(bb);
  });

  router.post("/focus", authed, json, async (req: Request, res: Response) => {
    const raw = (req.body as { handle?: unknown } | undefined)?.handle;
    const handle = typeof raw === "string" ? raw.trim() : "";
    if (raw !== null && typeof raw !== "string") {
      res.status(400).json({ error: "handle must be a string or null" });
      return;
    }
    if (handle && !registry().handles[handle]) {
      res.status(400).json({ error: `unknown handle: ${handle}` });
      return;
    }
    const focus = handle ? { handle, at: new Date().toISOString() } : { handle: null };
    await writeDataFile(FOCUS_FILE, `${JSON.stringify(focus, null, 1)}\n`);
    res.json({ ok: true, focus: handle || null });
  });

  router.get("/focus", authed, async (_req: Request, res: Response) => {
    const focus = await readFocus();
    res.json({
      focus: focus?.handle ?? null,
      ...(focus ? { at: focus.at } : {}),
      effective: await effectiveFocus(focus),
    });
  });

  router.get("/fleet", authed, (_req: Request, res: Response) => {
    res.json(registry());
  });

  return router;
}
