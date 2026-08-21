// Zero-dep authenticated call against the Google Calendar REST API. Usage:
//   node gcal.mjs <METHOD> <path-under-/calendar/v3/> [json-body]
//   node gcal.mjs GET  "calendars/$CAL/events?timeMin=2026-08-21T00:00:00Z&singleEvents=true&orderBy=startTime"
//   node gcal.mjs POST "calendars/$CAL/events" '{"summary":"Call","start":{"dateTime":"..."},"end":{"dateTime":"..."}}'
// Auth: GOOGLE_CALENDAR_OAUTH_JSON = {"client_id","client_secret","refresh_token"}
// (a Fly secret — never hardcoded, never committed). The refresh token was
// granted once by the calendar owner via OAuth consent on an Internal
// Workspace app, so it does not expire; each run swaps it for a 1h access token.

const [method, path, body] = process.argv.slice(2);
if (!method || !path) {
  console.error("usage: node gcal.mjs <METHOD> <path> [json-body]");
  process.exit(2);
}
const oauthJson = process.env.GOOGLE_CALENDAR_OAUTH_JSON;
if (!oauthJson) {
  console.error("GOOGLE_CALENDAR_OAUTH_JSON is not configured — calendar access is disabled on this deployment.");
  process.exit(3);
}
const { client_id, client_secret, refresh_token } = JSON.parse(oauthJson);

const tok = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", client_id, client_secret, refresh_token }),
});
if (!tok.ok) {
  console.error("token refresh failed:", tok.status, await tok.text());
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
