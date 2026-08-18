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

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const request = (path: string): Promise<Reply> => new Promise((resolve, reject) => {
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

  const feed = await request("/sites/testsite/feed");
  assert.equal(feed.status, 200);
  assert.equal(feed.body, feedBody, "feed contents should be served verbatim");
  assert.equal(feed.headers["cache-control"], "no-store");

  await rm(feedPath);
  const missingFeed = await request("/sites/testsite/feed");
  assert.equal(missingFeed.status, 200);
  assert.deepEqual(JSON.parse(missingFeed.body), { updatedAt: null, candidates: [], meetings: [] });

  const file = await request("/sites/testsite/files/a.txt");
  assert.equal(file.status, 200);
  assert.equal(file.body, "hello\n");
  assert.match(file.headers["content-type"] ?? "", /^text\/plain\b/);
  assert.equal(file.headers["cache-control"], "no-store");

  assert.equal((await request("/sites/testsite/files/../../../../etc/passwd")).status, 404);
  assert.equal((await request("/sites/testsite/files/%2E%2E%2F%2E%2E%2F%2E%2E%2F%2E%2E%2Fetc%2Fpasswd")).status, 404);
  assert.equal((await request("/sites/testsite/files/missing.txt")).status, 404);
} finally {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
  await rm(temp, { recursive: true, force: true });
}

console.log("feed-check OK — feed fallback, file serving, cache headers, and traversal guards all pass.");
