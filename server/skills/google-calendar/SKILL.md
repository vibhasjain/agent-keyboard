---
name: google-calendar
description: Read and write the owner's Google Calendar over the REST API (list events, check availability, create/update/delete events). Use whenever the owner asks about their calendar, schedule, meetings, availability, or wants something booked or moved.
---

# google-calendar

Direct Google Calendar REST API access as the owner. Requires the
`GOOGLE_CALENDAR_OAUTH_JSON` (`{"client_id","client_secret","refresh_token"}`
from a one-time owner consent) and `GOOGLE_CALENDAR_ID` (the calendar's
address, e.g. `owner@example.com`) environment variables — Fly secrets on
configured deployments, never in this repo. If unset, say so: "Calendar access
isn't configured on this deployment — the owner needs to set the
GOOGLE_CALENDAR_OAUTH_JSON and GOOGLE_CALENDAR_ID secrets."

## How

```bash
node ~/.claude/skills/google-calendar/gcal.mjs <METHOD> <path> [json-body]
```

`<path>` is anything under `https://www.googleapis.com/calendar/v3/`. Output is
the raw JSON response. Always URL-encode the calendar id in paths.

```bash
CAL=$(node -p 'encodeURIComponent(process.env.GOOGLE_CALENDAR_ID)')

# Today's events (use the owner's timezone for the bounds)
node ~/.claude/skills/google-calendar/gcal.mjs GET \
  "calendars/$CAL/events?timeMin=2026-08-21T00:00:00-04:00&timeMax=2026-08-22T00:00:00-04:00&singleEvents=true&orderBy=startTime"

# Free/busy
node ~/.claude/skills/google-calendar/gcal.mjs POST freeBusy \
  '{"timeMin":"2026-08-21T13:00:00Z","timeMax":"2026-08-21T22:00:00Z","items":[{"id":"'"$GOOGLE_CALENDAR_ID"'"}]}'

# Create
node ~/.claude/skills/google-calendar/gcal.mjs POST "calendars/$CAL/events" \
  '{"summary":"Intro call — Jane","start":{"dateTime":"2026-08-22T15:00:00-04:00"},"end":{"dateTime":"2026-08-22T15:30:00-04:00"},"attendees":[{"email":"jane@example.com"}]}'

# Update (PATCH) / delete
node ~/.claude/skills/google-calendar/gcal.mjs PATCH  "calendars/$CAL/events/<eventId>" '{"summary":"Renamed"}'
node ~/.claude/skills/google-calendar/gcal.mjs DELETE "calendars/$CAL/events/<eventId>"
```

An `invalid_grant` at token refresh means the owner revoked the grant — they
need to re-run the consent once. Never print the secret, refresh token or
access token.
