// Unit-style check of Google ID-token signature and Workspace claim verification.
// Run: `npx tsx src/dev/google-auth-check.ts` (kept out of the Docker image path).

import assert from "node:assert/strict";
import { createPublicKey, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const clientIdA = "google-auth-check-a.apps.googleusercontent.com";
const clientIdB = "google-auth-check-b.apps.googleusercontent.com";
const jwksUrl = "https://www.googleapis.com/oauth2/v3/certs";
const kid = "google-auth-check-key";
const temp = await mkdtemp(join(tmpdir(), "agent-keyboard-google-auth-"));
await mkdir(join(temp, "agent-keyboard"), { recursive: true });
await writeFile(
  join(temp, "agent-keyboard", "allowed-emails.json"),
  `${JSON.stringify([{ email: "friend@gmail.com", sites: ["cv-jobs"] }], null, 2)}\n`,
);
process.env.AGENT_DATA_DIR = temp;
process.env.GOOGLE_OAUTH_CLIENT_ID = `${clientIdA},${clientIdB}`;
process.env.ALLOWED_EMAIL = "owner@gmail.com";
process.env.GOOGLE_HD_SITES = "closeout-jobs,closeout";
process.env.SESSION_SECRET = "google-auth-check-session-secret";

const signingKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = createPublicKey(signingKeys.privateKey).export({ format: "jwk" });

globalThis.fetch = async (input) => {
  const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  assert.equal(url, jwksUrl);
  return {
    ok: true,
    status: 200,
    json: async () => ({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }),
    headers: { get: (name: string) => name.toLowerCase() === "cache-control" ? "public, max-age=3600" : null },
  } as Response;
};

function encode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function mint(payload: Record<string, unknown>, privateKey: KeyObject = signingKeys.privateKey, tokenKid = kid): string {
  const message = `${encode({ alg: "RS256", typ: "JWT", kid: tokenKid })}.${encode(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(message);
  signer.end();
  return `${message}.${signer.sign(privateKey).toString("base64url")}`;
}

const now = Math.floor(Date.now() / 1000);
const validClaims: Record<string, unknown> = {
  iss: "https://accounts.google.com",
  aud: clientIdA,
  hd: "hypertrack.io",
  email_verified: true,
  exp: now + 3600,
  sub: "google-user-123",
  email: "viewer@hypertrack.io",
};
const claims = (jti: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...validClaims,
  jti,
  ...overrides,
});

try {
  const { allowsSite, mintGoogleSession, verifyGoogle, verifyGoogleSession } = await import("../auth.js");

  const workspaceUser = await verifyGoogle(mint(claims("valid-workspace")));
  assert.deepEqual(workspaceUser, {
    id: "google-user-123",
    email: "viewer@hypertrack.io",
    hd: "hypertrack.io",
    scope: { sites: ["closeout-jobs", "closeout"] },
  });
  assert.ok(workspaceUser);
  assert.equal(allowsSite(workspaceUser, "closeout"), true);
  assert.equal(allowsSite(workspaceUser, "cv-jobs"), false);

  const ownerUser = await verifyGoogle(mint(claims("owner", {
    hd: undefined,
    sub: "owner-google-user",
    email: "owner@gmail.com",
  })));
  assert.deepEqual(ownerUser, { id: "owner-google-user", email: "owner@gmail.com" });

  const friendUser = await verifyGoogle(mint(claims("friend", {
    hd: undefined,
    sub: "friend-google-user",
    email: "friend@gmail.com",
  })));
  assert.equal(friendUser?.id, "friend-google-user");
  assert.equal(friendUser?.email, "friend@gmail.com");
  assert.deepEqual(friendUser?.scope?.sites, ["cv-jobs"]);

  assert.equal(await verifyGoogle(mint(claims("random", {
    hd: undefined,
    email: "random@gmail.com",
  }))), null);
  assert.equal(await verifyGoogle(mint(claims("owner-wrong-hd", {
    hd: "evil.com",
    email: "owner@gmail.com",
  }))), null);

  assert.deepEqual(await verifyGoogle(mint(claims("second-client", { aud: clientIdB }))), workspaceUser);
  assert.equal(await verifyGoogle(mint(claims("unknown-aud", { aud: "unknown-client-id" }))), null);
  assert.equal(await verifyGoogle(mint(claims("array-aud", { aud: [clientIdA] }))), null);
  assert.equal(await verifyGoogle(mint(claims("case-mismatched-aud", { aud: clientIdA.toUpperCase() }))), null);
  assert.equal(await verifyGoogle(mint(claims("missing-hd", { hd: undefined }))), null);
  assert.equal(await verifyGoogle(mint(claims("wrong-hd", { hd: "evil.com" }))), null);
  assert.equal(await verifyGoogle(mint(claims("unverified-email", { email_verified: false }))), null);
  assert.equal(await verifyGoogle(mint(claims("expired", { exp: now - 1 }))), null);
  assert.equal(await verifyGoogle(mint(claims("wrong-issuer", { iss: "https://accounts.evil.com" }))), null);

  const unsigned = `${encode({ alg: "none", typ: "JWT", kid })}.${encode(claims("unsigned"))}.unsigned`;
  assert.equal(await verifyGoogle(unsigned), null);
  assert.equal(await verifyGoogle(mint(claims("bad-signature"), otherKeys.privateKey)), null);
  assert.equal(await verifyGoogle(mint(claims("unknown-kid"), signingKeys.privateKey, "unknown-key")), null);

  assert.ok(ownerUser);
  const ownerSession = mintGoogleSession(ownerUser, now);
  assert.equal(ownerSession.exp, now + 30 * 24 * 60 * 60);
  const [, ownerSessionPayload] = ownerSession.sessionToken.split(".");
  assert.ok(ownerSessionPayload);
  assert.equal(JSON.parse(Buffer.from(ownerSessionPayload, "base64url").toString("utf8")).hd, null);
  assert.deepEqual(await verifyGoogleSession(ownerSession.sessionToken), {
    id: "owner@gmail.com",
    email: "owner@gmail.com",
  });

  const workspaceSession = mintGoogleSession(workspaceUser, now);
  assert.deepEqual(await verifyGoogleSession(workspaceSession.sessionToken), {
    id: "viewer@hypertrack.io",
    email: "viewer@hypertrack.io",
    hd: "hypertrack.io",
    scope: { sites: ["closeout-jobs", "closeout"] },
  });

  const randomSession = mintGoogleSession({ id: "random-google-user", email: "random@gmail.com" }, now);
  assert.equal(await verifyGoogleSession(randomSession.sessionToken), null);

  const expiredSession = mintGoogleSession(ownerUser, now - 30 * 24 * 60 * 60 - 1);
  assert.equal(await verifyGoogleSession(expiredSession.sessionToken), null);

  const [sessionHeader, sessionPayload, sessionSig] = ownerSession.sessionToken.split(".");
  assert.ok(sessionHeader && sessionPayload && sessionSig);
  const tamperedSig = `${sessionSig[0] === "A" ? "B" : "A"}${sessionSig.slice(1)}`;
  assert.equal(await verifyGoogleSession(`${sessionHeader}.${sessionPayload}.${tamperedSig}`), null);
} finally {
  await rm(temp, { recursive: true, force: true });
}

console.log("google-auth-check OK — Google ID tokens and long-lived sessions accept valid credentials and reject invalid, expired, and tampered tokens.");
