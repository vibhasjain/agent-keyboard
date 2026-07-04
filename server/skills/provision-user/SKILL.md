---
name: provision-user
description: Invite a new user to Agent Keyboard by email — Supabase emails them a link to set a password, and the email is added to the server's allow-list. Use when the owner asks to add, invite, or provision a user, or give someone access.
---

# provision-user

Give a new person access to Agent Keyboard: one command creates (or recovers)
their Supabase account, emails them a set-your-password link, and adds their
email to the server's allow-list so the auth gate accepts them.

```bash
node ~/.claude/skills/provision-user/invite.mjs someone@example.com [site-domain]
```

Pass the `site-domain` you're inviting them to (e.g. `agentkeyboard.com`) so the
email names it — if omitted, it uses the sole configured site, or a generic
phrase when several exist.

What it does:

1. Generates the auth link via Supabase admin `generate_link` (no Supabase email
   sent), then delivers a **branded, site-named email from your own domain via
   Resend** — the dark/amber template in `server/email-templates/`. If the
   account already exists it sends a recovery link instead (same landing).
   Without `RESEND_API_KEY` it falls back to Supabase's built-in mailer
   (generic template).
2. The link redirects to the invited site, where the bar detects the token and
   lets them set a password in place (no dependency on a `/welcome` page being
   allow-listed). The standalone `/welcome` page remains as a fallback.
3. Appends the email to `/data/agent-keyboard/allowed-emails.json` — the auth
   gate accepts emails from `ALLOWED_EMAIL` (env) plus this file.

Afterwards tell the owner: "<email> is invited — they'll get an email with a
link to set their password, then they can sign in from the bar on any of your
sites."

Requirements / failure modes (report plainly):

- `SUPABASE_SERVICE_KEY` unset → provisioning is disabled on this deployment.
- `RESEND_API_KEY` unset → emails still send, but via Supabase's generic mailer
  (not branded, doesn't name the site). Set it + `EMAIL_FROM` (a verified Resend
  sender) for the branded path.
- The invited site's domain must be in the Supabase project's allowed redirect
  list (Auth → URL Configuration) — it usually already is (it's the Site URL /
  where the bar signs people in). If the link lands somewhere without the bar,
  add the site there.
- If `ALLOWED_USER_ID` is set in the server env, it pins auth to specific
  user ids and provisioned users will still be rejected — the owner must unset
  it (or add the new user's id).

To revoke someone: remove their email from
`/data/agent-keyboard/allowed-emails.json` (and optionally delete the user in
the Supabase dashboard).
