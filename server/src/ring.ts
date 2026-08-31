// Ring webhook — the smart ring's phone app POSTs a voice transcription here and
// we forward it as a prompt to whichever fleet agent is currently "focused"
// (default: the master, @home). One press of the ring in, one durable job out.
//
// Three properties of the sender shape everything below:
//   1. The upload is async on the phone and a FAILED one is re-sent alongside the
//      NEXT recording. So anything we don't want repeated must answer 2xx — an
//      empty transcription is a 200, not a 400 — and every dispatch carries an
//      idemKey derived from recordedAt, so a genuine retry re-tails the original
//      job (see jobForIdem in jobs.ts) instead of running the prompt twice.
//   2. The POST is multipart and may carry an m4a of the recording. We never want
//      the audio: the file part is drained and discarded, never buffered.
//   3. Anyone on the internet can reach this route, so the shared secret is
//      checked BEFORE the body is parsed — an unauthenticated caller must not be
//      able to make us read 20MB off the wire.
//
// Focus lives in one small file on the volume and expires after two hours:
// "point the ring at @pixels" must not still be in effect tomorrow morning.

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

interface Target {
  site: string;
  page: string;
  url: string;
  authHeader: string;
  authSecret: string;
}

/** Where a handle's messages go: the loopback port when the handle lives on this
 *  instance, the peer's public URL otherwise (mirrors relay.sh's routing). */
function targetFor(name: string): Target | null {
  const reg = registry();
  const handle = reg.handles[name];
  const instance = handle ? reg.instances[handle.instance] : undefined;
  if (!handle || !instance) return null;
  const path = `/sites/${encodeURIComponent(handle.site)}/messages`;
  const page = handle.page ?? "/";
  // FLY_APP_NAME is unset in dev, where the instance we're standing in is "main".
  const local = process.env.FLY_APP_NAME
    ? instance.app === process.env.FLY_APP_NAME
    : handle.instance === "main";
  return local
    ? {
        site: handle.site,
        page,
        url: `http://127.0.0.1:${PORT}${path}`,
        authHeader: "x-ak-internal",
        authSecret: process.env.AK_INTERNAL_SECRET ?? "",
      }
    : {
        site: handle.site,
        page,
        url: `${instance.url.replace(/\/$/, "")}${path}`,
        authHeader: "x-ak-relay",
        authSecret: process.env.AK_RELAY_SECRET ?? "",
      };
}

/** Post the prompt and let go: the job is durable server-side, so holding the
 *  SSE stream open would only keep a socket alive for nobody (cf. cron.ts). */
async function dispatch(target: Target, text: string, idemKey: string): Promise<void> {
  const res = await fetch(target.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", [target.authHeader]: target.authSecret },
    body: JSON.stringify({ text, page: target.page, idemKey }),
  });
  await res.body?.cancel();
  if (!res.ok) {
    console.error(`[ring] enqueue failed for ${target.site}: ${res.status} ${res.statusText}`);
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
    if (!isRingSecret(req.header("x-ring-secret") ?? "")) {
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
        const handle = await effectiveFocus(await readFocus());
        const target = targetFor(handle);
        console.log(`[ring] trigger=${trigger} routed=${handle} len=${transcription.length}`);
        if (!target) {
          // Only reachable with a broken registry; a non-2xx lets the phone
          // re-send this recording with the next one, once we've fixed it.
          finish(503, { error: `no route for handle ${handle}` });
          return;
        }
        // A retry arrives as the same recordedAt, so the same idemKey — the
        // messages route then re-tails the first job instead of re-running it.
        const idemKey = /^\d+$/.test(recordedAt) ? `ring-${recordedAt}` : randomUUID();
        void dispatch(target, `[ring] ${transcription}`, idemKey).catch((err) =>
          console.error(`[ring] dispatch to ${handle} failed`, String(err)),
        );
        finish(200, { ok: true, routed: handle });
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
