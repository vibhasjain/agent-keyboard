// Real-HTTP check of the generalized per-site feed and file routes.
// Run: `npx tsx src/dev/feed-check.ts` (kept out of the Docker image path).

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, get, type IncomingHttpHeaders } from "node:http";
import { type AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";

const temp = await mkdtemp(join(tmpdir(), "agent-keyboard-feed-"));
process.env.AGENT_DATA_DIR = temp;
process.env.SITES = JSON.stringify([
  { id: "testsite", repo: "https://example.com/test.git", branch: "main", domain: "test.example.com" },
]);

const feedBody = `${JSON.stringify({ updatedAt: "2026-08-18T12:00:00Z", candidates: [{ id: 1 }], meetings: [] }, null, 2)}\n`;
const cloud = join(temp, "checkouts", "testsite", "cloud");
const feedPath = join(cloud, "feed.json");
await mkdir(join(cloud, "files"), { recursive: true });
await writeFile(feedPath, feedBody);
await writeFile(join(cloud, "files", "a.txt"), "hello\n");

const { registerFeedRoutes } = await import("../feed.js");
const app = express();
registerFeedRoutes(app, (_req, _res, next) => next());
const server = createServer(app);
let scopedSites = ["other"];
const scopedApp = express();
registerFeedRoutes(scopedApp, (req, _res, next) => {
  (req as typeof req & { user?: { id: string; email: string; scope: { sites: string[] } } }).user = {
    id: "u",
    email: "x@y.z",
    scope: { sites: scopedSites },
  };
  next();
});
const scopedServer = createServer(scopedApp);

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

const listen = (target: typeof server): Promise<number> => new Promise((resolve, reject) => {
  target.once("error", reject);
  target.listen(0, "127.0.0.1", () => resolve((target.address() as AddressInfo).port));
});

const request = (port: number, path: string): Promise<Reply> => new Promise((resolve, reject) => {
  const req = get({ host: "127.0.0.1", port, path }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => resolve({
      status: res.statusCode ?? 0,
      headers: res.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    }));
  });
  req.on("error", reject);
});

const close = (target: typeof server): Promise<void> => new Promise((resolve, reject) => {
  target.close((err) => err ? reject(err) : resolve());
});

try {
  const port = await listen(server);
  const scopedPort = await listen(scopedServer);

  const feed = await request(port, "/sites/testsite/feed");
  assert.equal(feed.status, 200);
  assert.equal(feed.body, feedBody, "feed contents should be served verbatim");
  assert.equal(feed.headers["cache-control"], "no-store");

  assert.equal((await request(scopedPort, "/sites/testsite/feed")).status, 403);
  assert.equal((await request(scopedPort, "/sites/testsite/files/a.txt")).status, 403);
  scopedSites = ["testsite"];
  assert.equal((await request(scopedPort, "/sites/testsite/feed")).status, 200);
  assert.equal((await request(scopedPort, "/sites/testsite/files/a.txt")).status, 200);

  await rm(feedPath);
  const missingFeed = await request(port, "/sites/testsite/feed");
  assert.equal(missingFeed.status, 200);
  assert.deepEqual(JSON.parse(missingFeed.body), { updatedAt: null, candidates: [], meetings: [] });

  const file = await request(port, "/sites/testsite/files/a.txt");
  assert.equal(file.status, 200);
  assert.equal(file.body, "hello\n");
  assert.match(file.headers["content-type"] ?? "", /^text\/plain\b/);
  assert.equal(file.headers["cache-control"], "no-store");

  assert.equal((await request(port, "/sites/testsite/files/../../../../etc/passwd")).status, 404);
  assert.equal((await request(port, "/sites/testsite/files/%2E%2E%2F%2E%2E%2F%2E%2E%2F%2E%2E%2Fetc%2Fpasswd")).status, 404);
  assert.equal((await request(port, "/sites/testsite/files/missing.txt")).status, 404);
} finally {
  if (server.listening) await close(server);
  if (scopedServer.listening) await close(scopedServer);
  await rm(temp, { recursive: true, force: true });
}

console.log("feed-check OK — feed fallback, file serving, cache headers, and traversal guards all pass.");
