// Server-Sent Events framing. Every
// durable-job stream — the POST /messages response and the GET /jobs/:id/stream
// re-attach — is a text/event-stream of `event: <name>\ndata: <json>\n\n` frames.
// A trailing `: ka` comment keeps proxies from buffering/closing an idle stream.

import type { Response } from "express";

/** One SSE frame: a named event carrying a JSON payload. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no", // tell nginx/Fly's proxy not to buffer
} as const;

/** Write the SSE headers and flush them so the client sees the stream open immediately. */
export function openSse(res: Response): void {
  for (const [k, v] of Object.entries(SSE_HEADERS)) res.setHeader(k, v);
  res.flushHeaders?.();
}

/** Write one frame; swallow errors (the client may have disconnected). */
export function writeFrame(res: Response, event: string, data: unknown): void {
  try {
    res.write(sseFrame(event, data));
  } catch {
    /* client gone */
  }
}

/** Start a keepalive comment ping; returns a stop() to clear the timer. */
export function startKeepalive(res: Response, intervalMs = 15_000): () => void {
  const timer = setInterval(() => {
    try {
      res.write(": ka\n\n");
    } catch {
      /* client gone */
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
