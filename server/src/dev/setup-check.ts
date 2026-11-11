// One-click installer against a fake flyctl (no Fly resources): `npm run setup-check`.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = mkdtempSync(join(tmpdir(), "fakefly-"));
const log = join(bin, "log");
// Records argv + stdin + env; the app doesn't exist yet, so `status` fails once.
writeFileSync(join(bin, "flyctl"), `#!/bin/sh
echo "ARGS $* TOKEN=$FLY_API_TOKEN HOME=$HOME" >> ${log}
case "$1 $2" in
  "status "*) [ -f ${bin}/created ] || { echo "Could not find App ghost-tok-123"; exit 1; } ;;
  "apps create") touch ${bin}/created ;;
  "volumes list") echo "[]" ;;
  "tokens create") echo '{"token":"FlyV1 deploytok"}' ;;
  "secrets import") cat >> ${log}; echo >> ${log} ;;
  "deploy "*) cat "$3" >> ${log} ;;
esac
`);
chmodSync(join(bin, "flyctl"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
const { parseInput, deploy } = await import("../setup.js");

const secrets = {
  SITES: '[{"id":"blog","repo":"https://github.com/u/blog.git","branch":"main","domain":"blog.example.com"}]',
  SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_KEY: "svc",
  ALLOWED_EMAIL: "a@b.co", GH_TOKEN: "ghp_secret", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-secret",
};
const body = { flyToken: "org-tok-123", app: "my-ak", region: "ord", secrets };

assert.equal(parseInput({ ...body, app: "Bad_Name" }), "app must be 3-42 chars: lowercase letters, digits, dashes");
assert.equal(parseInput({ ...body, secrets: { ...secrets, GH_TOKEN: "" } }), "GH_TOKEN is required");
assert.match(String(parseInput({ ...body, secrets: { ...secrets, SITES: "[]" } })), /non-empty/);
assert.match(String(parseInput({ ...body, secrets: { ...secrets, ALLOWED_EMAIL: "a@b.co\nX=1" } })), /one line/);
const input = parseInput(body);
assert.ok(typeof input !== "string");

const out = await deploy(input);
assert.deepEqual(out, {
  ok: true, url: "https://my-ak.fly.dev",
  steps: ["create app", "create volume", "create update token", "set secrets", "deploy"].map((step) => ({ step, ok: true })),
});
const l = readFileSync(log, "utf8");
assert.match(l, /ARGS apps create my-ak -o personal -y TOKEN=org-tok-123/);
assert.match(l, /volumes create agent_data --size 1 --region ord -y -a my-ak/);
assert.match(l, /GH_TOKEN=ghp_secret\n/); // secrets go via stdin...
assert.ok(!/ARGS[^\n]*ghp_secret/.test(l)); // ...never argv
assert.match(l, /FLY_API_TOKEN=FlyV1 deploytok/); // instance gets the app-scoped token, not the org one
assert.match(l, /--image ghcr\.io\/vibhasjain\/agent-keyboard:latest --ha=false -y -a my-ak/);
assert.match(l, /AK_PUBLIC_URL = "https:\/\/my-ak\.fly\.dev"/);
assert.ok(!l.includes("HOME=/data"), "flyctl must not run with this server's HOME");

// Re-run is idempotent: app exists, volume exists -> no create calls.
writeFileSync(log, "");
writeFileSync(join(bin, "flyctl"), readFileSync(join(bin, "flyctl"), "utf8").replace('echo "[]"', `echo '[{"name": "agent_data"}]'`));
assert.ok((await deploy(input)).ok);
assert.ok(!/apps create|volumes create/.test(readFileSync(log, "utf8")));

// A failure surfaces flyctl's output with every secret redacted.
writeFileSync(join(bin, "flyctl"), `#!/bin/sh\necho "boom org-tok-123 ghp_secret" >&2; exit 1\n`);
const bad = await deploy(input);
assert.equal(bad.ok, false);
assert.equal(bad.steps.at(-1)?.detail, "boom [hidden] [hidden]");
console.log("setup-check ok");
