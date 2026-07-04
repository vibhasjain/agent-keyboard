# Branded auth emails

Branded, email-client-safe templates for the Supabase auth emails (invite +
password recovery). Dark card, amber button, the ⌨️ mark — table layout and
inline styles only, system fonts (webfonts don't load in most clients).

`{{ .ConfirmationURL }}` and `{{ .Email }}` are Supabase template variables —
leave them intact.

## One-time setup (all free)

1. **Resend** (or any SMTP provider with a free tier): create an account at
   resend.com, add `agentkeyboard.com` as a domain, and add the DNS records it
   gives you (DKIM/SPF/return-path) to the domain's DNS. Wait for "verified".
2. **Supabase → Project Settings → Auth → SMTP**: enable custom SMTP with
   Resend's credentials (`smtp.resend.com:465`, user `resend`, password = an
   API key), sender `Agent Keyboard <invites@agentkeyboard.com>`.
3. **Supabase → Auth → Email Templates**: paste `invite.html` into *Invite
   user* (subject: `You're invited to Agent Keyboard`) and `recovery.html`
   into *Reset password* (subject: `Reset your Agent Keyboard password`).

Steps 2–3 can also be done headlessly with a Supabase personal access token
via the Management API (`PATCH /v1/projects/{ref}/config/auth` — the
`smtp_*` and `mailer_templates_*` fields).

After this, the existing `provision-user` skill needs no changes — invites
and recoveries just start arriving branded, from your domain, without
Supabase's built-in mailer rate limits (a couple of emails per hour).

Preview a template locally: `open invite.html` (or the bar's own
verify-in-browser skill can screenshot it).
