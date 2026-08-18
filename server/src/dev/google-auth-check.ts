// Unit-style check of Google ID-token signature and Workspace claim verification.
// Run: `npx tsx src/dev/google-auth-check.ts` (kept out of the Docker image path).

import assert from "node:assert/strict";
import { createPublicKey, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

const clientId = "google-auth-check.apps.googleusercontent.com";
const jwksUrl = "https://www.googleapis.com/oauth2/v3/certs";
const kid = "google-auth-check-key";
process.env.GOOGLE_OAUTH_CLIENT_ID = clientId;
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

const { mintGoogleSession, verifyGoogle, verifyGoogleSession } = await import("../auth.js");

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
  aud: clientId,
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

assert.deepEqual(
  await verifyGoogle(mint(claims("valid"))),
  { id: "google-user-123", email: "viewer@hypertrack.io" },
);
assert.equal(await verifyGoogle(mint(claims("wrong-aud", { aud: "wrong-client-id" }))), null);
assert.equal(await verifyGoogle(mint(claims("missing-hd", { hd: undefined }))), null);
assert.equal(await verifyGoogle(mint(claims("wrong-hd", { hd: "evil.com" }))), null);
assert.equal(await verifyGoogle(mint(claims("unverified-email", { email_verified: false }))), null);
assert.equal(await verifyGoogle(mint(claims("expired", { exp: now - 1 }))), null);
assert.equal(await verifyGoogle(mint(claims("wrong-issuer", { iss: "https://accounts.evil.com" }))), null);

const unsigned = `${encode({ alg: "none", typ: "JWT", kid })}.${encode(claims("unsigned"))}.unsigned`;
assert.equal(await verifyGoogle(unsigned), null);
assert.equal(await verifyGoogle(mint(claims("bad-signature"), otherKeys.privateKey)), null);
assert.equal(await verifyGoogle(mint(claims("unknown-kid"), signingKeys.privateKey, "unknown-key")), null);

const googleUser = { id: "google-user-123", email: "viewer@hypertrack.io" };
const session = mintGoogleSession(googleUser, now);
assert.equal(session.exp, now + 30 * 24 * 60 * 60);
assert.deepEqual(verifyGoogleSession(session.sessionToken), {
  id: "viewer@hypertrack.io",
  email: "viewer@hypertrack.io",
});

const expiredSession = mintGoogleSession(googleUser, now - 30 * 24 * 60 * 60 - 1);
assert.equal(verifyGoogleSession(expiredSession.sessionToken), null);

const [sessionHeader, sessionPayload, sessionSig] = session.sessionToken.split(".");
assert.ok(sessionHeader && sessionPayload && sessionSig);
const tamperedSig = `${sessionSig[0] === "A" ? "B" : "A"}${sessionSig.slice(1)}`;
assert.equal(verifyGoogleSession(`${sessionHeader}.${sessionPayload}.${tamperedSig}`), null);

console.log("google-auth-check OK — Google ID tokens and long-lived sessions accept valid credentials and reject invalid, expired, and tampered tokens.");
