---
name: self-ops
description: Operate the Agent Keyboard deployment you are running on — logs, secrets, machine status, deploys, Supabase auth config. Use when the owner asks about the server itself, deploys, secrets, boot problems, or anything ops-shaped, or says "update yourself" / "update Agent Keyboard to latest" (works from any site when AK_FORK_REPO is set).
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

"Update yourself" / "update Agent Keyboard to latest" works from **any** site's bar: `$AK_FORK_REPO`
(`owner/agent-keyboard`, set at setup) names this instance's fork, and you may clone and push it even
though it isn't your site's repo. Unset means this instance has no fork to update: say so and point the
owner to `AK_FORK_REPO` in `SELF_HOSTING.md` step 6. Do it all in one turn:

```bash
F="$AK_FORK_REPO"; R=.tmp/ak-fork
# 200 = GH_TOKEN can push the fork. Check FIRST, before any merge work:
curl -s -o /dev/null -w "%{http_code}\n" -u "x-access-token:$GH_TOKEN" "https://github.com/$F.git/info/refs?service=git-receive-pack"
[ -d $R ] || git clone "https://x-access-token:$GH_TOKEN@github.com/$F.git" $R
cd $R && git pull --ff-only origin main
git pull --no-rebase https://github.com/vibhasjain/agent-keyboard.git main
(cd server && npm ci --include=dev && npm run typecheck) && (cd widget && npm ci --include=dev && npm test)
git push origin main
```

- **Not 200:** say so once, up front, and stop: `GH_TOKEN` can't push `$F`. Either add the fork to the
  token (Repository access, Contents: Read and write), or click **Sync fork → Update branch** on
  `https://github.com/$F`. (`npm ci` needs `--include=dev`: the box runs with `NODE_ENV=production`.)
- **Conflicts:** take upstream, except keep the fork's `app =` in `server/fly.toml`.
- **Rejected because upstream changed `.github/workflows/`:** `GH_TOKEN` has no Workflows permission
  (see Known limits). Point the owner to **Sync fork → Update branch**, which can.
- **Confirm the deploy started.** A minute after the push, `gh run list --repo "$F" --workflow
  agent-keyboard-deploy.yml --limit 1` should show a run for the new head. If there's none, start one:
  `gh workflow run agent-keyboard-deploy.yml --repo "$F"`. If that fails, Actions are off on the fork
  (GitHub disables them on forks until the owner enables them once in the repo's **Actions** tab), or
  the `FLY_API_TOKEN` repo secret is missing (`SELF_HOSTING.md` step 6). Say which. Don't `fly deploy`
  from inside your own turn.
- The deploy restarts this machine a few minutes later. Tell the owner it's on its way.

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
