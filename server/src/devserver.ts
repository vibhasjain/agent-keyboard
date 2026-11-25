// Served sites (serve:true) whose repo has an npm "dev" script run it and are
// proxied to it, so a site that needs a build (Vite, Next, Astro…) previews
// properly instead of as raw files. Started lazily on the first request; if it
// fails, the site falls back to its files as they are and retries 10 min later.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import type { Request, Response } from "express";

type Dev = { port: number; ready: boolean; failedAt?: number };
const devs = new Map<string, Dev>();
const RETRY_MS = 10 * 60_000;
const BOOT_MS = 5 * 60_000; // npm install on a cold checkout can be slow

/** The dev server's port once it answers, "starting" while it boots, or null to serve the files. */
export function devServer(siteId: string, dir: string, port: number): number | "starting" | null {
  let d = devs.get(siteId);
  if (d?.ready) return d.port;
  if (d && !d.failedAt) return "starting";
  if (d?.failedAt && Date.now() - d.failedAt < RETRY_MS) return null;
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  if (!pkg.scripts?.dev) return null;
  const dev: Dev = { port, ready: false };
  devs.set(siteId, dev);
  // The repo's own code runs here: give it no server secrets. Its own process
  // group, so the whole tree (sh → npm → vite) dies with this server.
  const p = spawn("sh", ["-c", `npm install --no-audit --no-fund && exec npm run dev -- --port ${port}`], {
    cwd: dir,
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), BROWSER: "none" },
  });
  const kill = () => {
    try {
      process.kill(-p.pid!, "SIGTERM");
    } catch {}
  };
  process.once("exit", kill);
  const fail = () => {
    dev.ready = false;
    dev.failedAt ??= Date.now();
    kill();
  };
  p.on("exit", (code) => {
    console.log(`agent-keyboard: dev server for ${siteId} exited (${code})`);
    fail();
  });
  const started = Date.now();
  const poll = () => {
    if (dev.failedAt) return;
    if (Date.now() - started > BOOT_MS) return fail();
    http
      .get({ host: "localhost", port, path: "/", headers: { host: `localhost:${port}` } }, (r) => {
        r.resume();
        dev.ready = true;
        console.log(`agent-keyboard: dev server for ${siteId} up on :${port}`);
      })
      .on("error", () => setTimeout(poll, 1000));
  };
  setTimeout(poll, 1000);
  return "starting";
}

/** Proxy a request to the dev server. Host is rewritten: dev servers reject unknown hosts. */
export function proxyDev(req: Request, res: Response, port: number): void {
  const headers = { ...req.headers, host: `localhost:${port}` };
  // express.json() already read JSON bodies; send them on re-serialized.
  const body = (req as { _body?: boolean })._body ? Buffer.from(JSON.stringify(req.body)) : null;
  if (body) headers["content-length"] = String(body.length);
  const up = http.request({ host: "localhost", port, method: req.method, path: req.originalUrl, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => (res.headersSent ? res.end() : res.status(502).send("The dev server didn't answer.")));
  if (body) up.end(body);
  else req.pipe(up);
}

/** Proxy a WebSocket upgrade (hot reload) to the dev server. */
export function proxyDevUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer, port: number): void {
  const up = net.connect(port, "localhost", () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i]!;
      lines.push(`${k}: ${k.toLowerCase() === "host" ? `localhost:${port}` : req.rawHeaders[i + 1]}`);
    }
    up.write(lines.join("\r\n") + "\r\n\r\n");
    up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
}
