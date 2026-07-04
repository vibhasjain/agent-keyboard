---
name: provision-user
description: Invite a new user to Agent Keyboard by email — Supabase emails them a link to set a password, and the email is added to the server's allow-list. Use when the owner asks to add, invite, or provision a user, or give someone access.
---

# provision-user

Give a new person access to Agent Keyboard: one command creates (or recovers)
their Supabase account, emails them a set-your-password link, and adds their
email to the server's allow-list so the auth gate accepts them.

```bash
node ~/.claude/skills/provision-user/invite.mjs someone@example.com
```

What it does:

1. `POST /auth/v1/invite` on the configured Supabase project (service key from
   the environment). If the account already exists, it falls back to a
   password-recovery email — same outcome, a link to set a password.
2. The link lands on this server's `/welcome` page, where they set a password.
3. Appends the email to `/data/agent-keyboard/allowed-emails.json` — the auth
   gate accepts emails from `ALLOWED_EMAIL` (env) plus this file.

Afterwards tell the owner: "<email> is invited — they'll get an email with a
link to set their password, then they can sign in from the bar on any of your
sites."

Requirements / failure modes (report plainly):

- `SUPABASE_SERVICE_KEY` unset → provisioning is disabled on this deployment.
- The `/welcome` redirect URL must be in the Supabase project's allowed
  redirect list (Auth → URL Configuration) — if the emailed link bounces to
  the wrong page, that's the fix.
- If `ALLOWED_USER_ID` is set in the server env, it pins auth to specific
  user ids and provisioned users will still be rejected — the owner must unset
  it (or add the new user's id).

To revoke someone: remove their email from
`/data/agent-keyboard/allowed-emails.json` (and optionally delete the user in
the Supabase dashboard).
