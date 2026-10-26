---
name: self-ops
description: Operate the Agent Keyboard deployment you are running on — logs, secrets, machine status, deploys, Supabase auth config. Use when the owner asks about the server itself, deploys, secrets, boot problems, or anything ops-shaped (only meaningful on the site whose repo IS agent-keyboard).
---

# self-ops

You don't just edit websites — on the agent-keyboard repo you ARE the product,
running on the very Fly machine you're operating. This skill is the map.

## The one thing to never forget

**You are inside the machine you manage.** `fly deploy`, `fly secrets set`,
and `fly machine restart` RESTART this machine — which kills the CLI process
running your current turn. The job dies mid-flight; your reply never arrives;
the owner sees "interrupted". So:

- **Code changes deploy themselves**: commit + push to `main` — GitHub Actions
  runs `flyctl deploy` for anything touching `server/**` or `widget/**`, and
  Netlify redeploys `site/**`. This is ALWAYS the preferred path: the restart
  happens minutes later, after your turn finished.
- **`fly secrets set` restarts immediately.** Do it as the LAST action of a
  turn, and tell the owner first: "setting this will restart me — my reply may
  cut off; give it a minute and message again."
- Read-only commands (`fly logs`, `fly status`, `fly secrets list`) are always
  safe.

## Prerequisites

`flyctl` is preinstalled. It authenticates via the `FLY_API_TOKEN` env var
(an app-scoped deploy token — optional Fly secret). If it's unset, say so:
"self-ops isn't enabled on this deployment — the owner needs to set the
FLY_API_TOKEN secret."

Always pass the app explicitly: `-a "$FLY_APP_NAME"` (Fly sets it; on the original
instance it's `agent-keyboard`).

## Common operations

```bash
fly status -a "$FLY_APP_NAME"                  # machine state
fly logs -a "$FLY_APP_NAME" --no-tail | tail -50   # recent logs (incl. your own boot)
fly secrets list -a "$FLY_APP_NAME"            # names + digests only, never values
fly secrets set NAME="value" -a "$FLY_APP_NAME"    # ⚠ restarts this machine (see above)
```

Deploy status after you push: check the Actions run on the repo
(`gh run list --limit 1` from your checkout — gh is installed
and GH_TOKEN is in your env).

## Updating your own Claude Code CLI

Your CLI version is PINNED in `server/Dockerfile` (a line like
`npm install -g @anthropic-ai/claude-code@2.1.170`). It does not auto-update —
headless `-p` runs never trigger the self-updater, and every deploy rebuilds
from the pin. To update ("update my Claude to latest"):

```bash
npm view @anthropic-ai/claude-code version   # the newest published version
```

Then edit that one line in `server/Dockerfile` to the new version, commit, and
push to `main`. The deploy workflow rebuilds the image with the new CLI (the
Dockerfile is NOT under `.github/workflows/`, so the GH_TOKEN restriction
doesn't block it). The restart lands minutes later, after your turn — so tell
the user "it'll update on the next deploy, ~2-3 min." Pin a specific version,
never the floating `latest` tag, so builds stay reproducible.

## Updating Agent Keyboard to latest (self-hosted forks)

On a fork ("update Agent Keyboard to latest"), merge upstream and push; CI deploys it:

```bash
git pull --no-rebase https://github.com/vibhasjain/agent-keyboard.git main
git push origin main     # the fork's CI (FLY_API_TOKEN repo secret) deploys ~2-3 min later
```

Resolve conflicts in favour of upstream, except keep the fork's `app =` in `server/fly.toml`. If the
push is rejected because upstream changed `.github/workflows/`, that's the Workflows limit below: the
owner runs `gh repo sync` or merges once on github.com. No CI run after the push means the repo secret
is missing: say so (see `SELF_HOSTING.md` step 6) rather than `fly deploy` from inside your own turn.

## Where your own state lives (the /data volume)

- `/data/checkouts/<site>` — per-site working copies (yours is the cwd)
- `/data/agent-keyboard/sites/<site>/settings.json` — your harness settings
- `/data/agent-keyboard/allowed-emails.json` — provisioned users (auth gate)
- `/data/.claude/skills/` — your skills (repo-seeded + self-installed)
- `/data/.claude/projects/…` — your session memory (JSONLs). Don't edit these.

## Supabase auth config (optional)

If the `SUPABASE_ACCESS_TOKEN` secret is set (a personal access token, not the
service key), you can manage auth config headlessly via the Management API —
SMTP settings, email templates, redirect URLs:

```bash
# project ref = the subdomain of $SUPABASE_URL
REF=$(echo "$SUPABASE_URL" | sed -E 's#https://([^.]+).*#\1#')
curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/$REF/config/auth" | jq 'keys'
# PATCH the same endpoint to update: smtp_host, smtp_user, smtp_pass,
# smtp_admin_email, mailer_subjects_invite, mailer_templates_invite_content, …
```

Branded email templates live in the repo at `server/email-templates/`.

## Known limits (tell the owner, don't fight them)

- **`.github/workflows/` edits are rejected on push** — GH_TOKEN deliberately
  lacks the Workflows permission. CI changes need the owner to either grant
  the PAT that permission or apply the change themselves.
- A `fly.toml` or `Dockerfile` change also deploys via push like everything
  else — no special handling needed.
