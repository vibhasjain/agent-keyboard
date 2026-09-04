// View-only live browser streaming. Chromium exposes JPEG frames over CDP;
// this module shares one screencast per site across every attached SSE viewer.

import type { Request, Response } from "express";
import { cdpPortFor } from "./claude.js";
import { SITES } from "./sites.js";
import { openSse, startKeepalive, writeFrame } from "./sse.js";

const DETECT_MS = 3_000;
const TARGET_REFRESH_MS = 5_000;
const FRAME_MS = 250; // at most 4 fps
const CDP_TIMEOUT_MS = 1_500;

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

export interface ScreenFrame {
  jpeg: string | null;
  w?: number;
  h?: number;
  url?: string;
  title?: string;
  reason?: string;
}

type Viewer = (frame: ScreenFrame) => void;

interface ScreenSession {
  siteId: string;
  viewers: Set<Viewer>;
  socket: WebSocket | null;
  target: CdpTarget | null;
  lastFrame: ScreenFrame | null;
  lastFrameAt: number;
  commandId: number;
  checking: boolean;
  closed: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  targetTimer: ReturnType<typeof setInterval> | null;
}

const browserLive = new Map<string, boolean>();
const sessions = new Map<string, ScreenSession>();

export function browserLiveFor(siteId: string): boolean {
  return browserLive.get(siteId) ?? false;
}

export function withBrowserStatus(
  siteId: string,
  status: Record<string, unknown>,
): Record<string, unknown> {
  return { ...status, browser: browserLiveFor(siteId) };
}

async function targetsFor(siteId: string): Promise<CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${cdpPortFor(siteId)}/json/list`, {
    signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`CDP target list returned ${response.status}`);
  const raw = (await response.json()) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): CdpTarget[] => {
    if (!entry || typeof entry !== "object") return [];
    const target = entry as Record<string, unknown>;
    if (
      typeof target.id !== "string" ||
      typeof target.type !== "string" ||
      typeof target.url !== "string"
    ) return [];
    return [{
      id: target.id,
      type: target.type,
      url: target.url,
      title: typeof target.title === "string" ? target.title : "",
      ...(typeof target.webSocketDebuggerUrl === "string"
        ? { webSocketDebuggerUrl: target.webSocketDebuggerUrl }
        : {}),
    }];
  });
}

function preferredPage(targets: CdpTarget[]): CdpTarget | null {
  const pages = targets.filter(
    (target) =>
      target.type === "page" &&
      target.url !== "about:blank" &&
      typeof target.webSocketDebuggerUrl === "string",
  );
  return pages[pages.length - 1] ?? null;
}

/** Poll CDP only for sites with an admitted running job. */
export function startBrowserDetection(
  activeSiteIds: () => Iterable<string>,
  onChange: (siteId: string) => void,
): () => void {
  let stopped = false;
  let polling = false;
  const setLive = (siteId: string, live: boolean) => {
    if (browserLiveFor(siteId) === live) return;
    browserLive.set(siteId, live);
    onChange(siteId);
  };
  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      const active = new Set(activeSiteIds());
      await Promise.all(SITES.map(async (site) => {
        if (!active.has(site.id)) {
          setLive(site.id, false);
          return;
        }
        try {
          await targetsFor(site.id);
          setLive(site.id, true);
        } catch {
          // Browser absent or mid-restart: reachability is best-effort.
          setLive(site.id, false);
        }
      }));
    } finally {
      polling = false;
    }
  };
  void poll();
  const timer = setInterval(() => void poll(), DETECT_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function screenLog(siteId: string, message: string, err?: unknown): void {
  const suffix = err == null ? "" : `: ${String((err as Error)?.message ?? err)}`;
  console.warn(`[screen] ${siteId} ${message}${suffix}`);
}

function sendCommand(
  session: ScreenSession,
  socket: WebSocket,
  method: string,
  params: Record<string, unknown> = {},
): void {
  if (socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify({ id: ++session.commandId, method, params }));
  } catch (err) {
    screenLog(session.siteId, `could not send ${method}`, err);
  }
}

function broadcast(session: ScreenSession, payload: ScreenFrame): void {
  session.lastFrame = payload;
  for (const viewer of session.viewers) {
    try {
      viewer(payload);
    } catch {
      /* one disconnected viewer never affects the shared cast */
    }
  }
}

function waiting(session: ScreenSession): void {
  if (session.lastFrame?.jpeg === null) return;
  broadcast(session, { jpeg: null, reason: "no browser" });
}

function clearRetry(session: ScreenSession): void {
  if (!session.retryTimer) return;
  clearTimeout(session.retryTimer);
  session.retryTimer = null;
}

function scheduleAttach(session: ScreenSession): void {
  if (session.closed || !session.viewers.size || session.retryTimer) return;
  session.retryTimer = setTimeout(() => {
    session.retryTimer = null;
    void syncTarget(session);
  }, DETECT_MS);
  session.retryTimer.unref?.();
}

function stopSocket(session: ScreenSession): void {
  const socket = session.socket;
  session.socket = null;
  session.target = null;
  if (!socket) return;
  sendCommand(session, socket, "Page.stopScreencast");
  try {
    socket.close();
  } catch {
    /* already closed */
  }
}

function connect(session: ScreenSession, target: CdpTarget): void {
  const endpoint = target.webSocketDebuggerUrl;
  if (!endpoint || session.closed || !session.viewers.size) return;
  let socket: WebSocket;
  try {
    socket = new WebSocket(endpoint);
  } catch (err) {
    screenLog(session.siteId, "could not open CDP socket", err);
    waiting(session);
    scheduleAttach(session);
    return;
  }
  session.socket = socket;
  session.target = target;
  const connectTimer = setTimeout(() => {
    if (session.socket !== socket || socket.readyState === 1) return;
    screenLog(session.siteId, "CDP socket handshake timed out");
    session.socket = null;
    session.target = null;
    try {
      socket.close();
    } catch {
      /* a still-connecting socket may reject close */
    }
    waiting(session);
    scheduleAttach(session);
  }, CDP_TIMEOUT_MS);
  connectTimer.unref?.();

  socket.addEventListener("open", () => {
    clearTimeout(connectTimer);
    if (session.closed || session.socket !== socket) {
      try {
        socket.close();
      } catch {
        /* stale socket */
      }
      return;
    }
    clearRetry(session);
    sendCommand(session, socket, "Page.startScreencast", {
      format: "jpeg",
      quality: 50,
      maxWidth: 960,
      maxHeight: 720,
      everyNthFrame: 1,
    });
  });

  socket.addEventListener("message", (event) => {
    if (session.closed || session.socket !== socket || typeof event.data !== "string") return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.method !== "Page.screencastFrame") return;
    const params = message.params as Record<string, unknown> | undefined;
    const sessionId = params?.sessionId;
    if (typeof sessionId !== "number") return;
    // ACK every frame immediately, including frames dropped by the UI throttle.
    sendCommand(session, socket, "Page.screencastFrameAck", { sessionId });
    const now = Date.now();
    if (now - session.lastFrameAt < FRAME_MS) return;
    const jpeg = typeof params?.data === "string" ? params.data : "";
    if (!jpeg) return;
    session.lastFrameAt = now;
    const metadata = (params?.metadata ?? {}) as Record<string, unknown>;
    const w = Number(metadata.deviceWidth) || 0;
    const h = Number(metadata.deviceHeight) || 0;
    broadcast(session, {
      jpeg,
      w,
      h,
      url: session.target?.url ?? "",
      title: session.target?.title ?? "",
    });
  });

  socket.addEventListener("error", () => {
    if (session.socket === socket) screenLog(session.siteId, "CDP socket error");
  });

  socket.addEventListener("close", () => {
    clearTimeout(connectTimer);
    if (session.socket !== socket) return;
    session.socket = null;
    session.target = null;
    if (session.closed || !session.viewers.size) return;
    waiting(session);
    scheduleAttach(session);
  });
}

async function syncTarget(session: ScreenSession): Promise<void> {
  if (session.closed || !session.viewers.size || session.checking) return;
  session.checking = true;
  try {
    const target = preferredPage(await targetsFor(session.siteId));
    if (session.closed || !session.viewers.size) return;
    if (!target) {
      stopSocket(session);
      waiting(session);
      scheduleAttach(session);
      return;
    }
    if (
      session.socket &&
      session.target?.webSocketDebuggerUrl === target.webSocketDebuggerUrl
    ) {
      // Same page after a navigation: refresh the caption without restarting CDP.
      session.target = target;
      return;
    }
    stopSocket(session);
    connect(session, target);
  } catch (err) {
    if (!session.socket) {
      waiting(session);
      scheduleAttach(session);
    } else {
      screenLog(session.siteId, "target refresh failed", err);
    }
  } finally {
    session.checking = false;
  }
}

function newSession(siteId: string): ScreenSession {
  const session: ScreenSession = {
    siteId,
    viewers: new Set<Viewer>(),
    socket: null,
    target: null,
    lastFrame: null,
    lastFrameAt: 0,
    commandId: 0,
    checking: false,
    closed: false,
    retryTimer: null,
    targetTimer: null,
  };
  session.targetTimer = setInterval(() => void syncTarget(session), TARGET_REFRESH_MS);
  session.targetTimer.unref?.();
  return session;
}

function watchScreen(siteId: string, viewer: Viewer): () => void {
  let session = sessions.get(siteId);
  if (!session) {
    session = newSession(siteId);
    sessions.set(siteId, session);
  }
  session.viewers.add(viewer);
  if (session.lastFrame) viewer(session.lastFrame);
  void syncTarget(session);
  return () => {
    if (!session || !session.viewers.delete(viewer) || session.viewers.size) return;
    session.closed = true;
    clearRetry(session);
    if (session.targetTimer) clearInterval(session.targetTimer);
    console.log(`[screen] ${siteId} screencast stopping (last viewer disconnected)`);
    stopSocket(session);
    sessions.delete(siteId);
  };
}

/** Attach one authenticated HTTP response to a site's shared screencast. */
export function streamScreen(req: Request, res: Response, siteId: string): void {
  openSse(res);
  const stopKeepalive = startKeepalive(res);
  let closed = false;
  const detach = watchScreen(siteId, (payload) => {
    if (!res.writableEnded && !res.writableNeedDrain) writeFrame(res, "screen", payload);
  });
  const close = () => {
    if (closed) return;
    closed = true;
    stopKeepalive();
    detach();
  };
  req.once("close", close);
  res.once("close", close);
}
