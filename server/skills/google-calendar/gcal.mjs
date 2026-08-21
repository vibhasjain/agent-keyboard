// Zero-dep authenticated call against the Google Calendar REST API. Usage:
//   node gcal.mjs <METHOD> <path-under-/calendar/v3/> [json-body]
//   node gcal.mjs GET  "calendars/$GOOGLE_CALENDAR_ID/events?timeMin=2026-08-21T00:00:00Z&singleEvents=true&orderBy=startTime"
//   node gcal.mjs POST "calendars/$GOOGLE_CALENDAR_ID/events" '{"summary":"Call","start":{"dateTime":"..."},"end":{"dateTime":"..."}}'
// Auth is a service account (GOOGLE_CALENDAR_SA_JSON, a Fly secret — never
// hardcoded, never committed): a self-signed RS256 JWT swapped for a 1h access
// token. No browser, no refresh token, never expires.

import { createSign } from "node:crypto";

const [method, path, body] = process.argv.slice(2);
if (!method || !path) {
  console.error("usage: node gcal.mjs <METHOD> <path> [json-body]");
  process.exit(2);
}
const saJson = process.env.GOOGLE_CALENDAR_SA_JSON;
if (!saJson) {
  console.error("GOOGLE_CALENDAR_SA_JSON is not configured — calendar access is disabled on this deployment.");
  process.exit(3);
}
const sa = JSON.parse(saJson);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const unsigned =
  b64({ alg: "RS256", typ: "JWT" }) +
  "." +
  b64({
    iss: sa.client_email,
    // Domain-wide delegation: act as the calendar's owner (Workspace admin has
    // authorised this SA's client id for the calendar scope).
    sub: process.env.GOOGLE_CALENDAR_ID,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  });
const jwt = unsigned + "." + createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");

const tok = await fetch(sa.token_uri, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
});
if (!tok.ok) {
  console.error("token exchange failed:", tok.status, await tok.text());
  process.exit(1);
}
const { access_token } = await tok.json();

const res = await fetch("https://www.googleapis.com/calendar/v3/" + path, {
  method: method.toUpperCase(),
  headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
  body,
});
const text = await res.text();
console.log(text);
if (!res.ok) process.exit(1);
