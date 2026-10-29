---
name: self-host
description: Set up a self-hosted Agent Keyboard server end to end with the user — Supabase, GitHub token, Claude token, Fly.io deploy, SITES config, and the script tag to paste. Use when someone has cloned the agent-keyboard repo and asks to set up, install, self-host, or deploy Agent Keyboard (or "get the bar working on my site"). Not for operating an already-running instance (that's self-ops).
---

# Set up a self-hosted Agent Keyboard

You're running on the user's own machine, in a clone of `agent-keyboard`. `SELF_HOSTING.md` is the
source of truth: follow its numbered steps in order, read each section before doing it, and do the work
with the user rather than handing them the doc. This file only adds what the doc can't: the order of
questions, the commands that verify each step, and the pitfalls.

Rules:
- One step at a time. Say what's next, ask only for what that step needs, verify it, move on.
- Never print a secret back. Shell variables don't survive between your commands, so keep pasted
  values in `~/.agent-keyboard-setup.env` (outside the repo, `chmod 600`) and `source` it in each
  command. Delete it at the end.
- If a check fails, stop and fix it there. Don't carry a broken step forward.
- Tell the user honestly that this takes about an hour, mostly waiting on the Fly build.

## 0. Preflight

```bash
node --version          # 22+ (only needed for local dev, but cheap to have)
flyctl version && flyctl auth whoami
gh --version && gh auth status
openssl version && jq --version
```

Missing `flyctl` → https://fly.io/docs/flyctl/install/ then `flyctl auth login`. Missing `gh` →
https://cli.github.com then `gh auth login`. Confirm they have a Claude Pro or Max subscription (the
server's CLI runs on it) — see the checklist at the top of `SELF_HOSTING.md`.

## 1. Ask about the site

Ask, in one message:
1. The site's GitHub repo (`owner/name`) and the branch its host deploys from (usually `main`).
2. The live domain, bare (`blog.example.com`, no `https://`, no path).
3. Where it's hosted: Netlify, Vercel, Cloudflare Pages, other.
4. A short id for the site (lowercase, e.g. `blog`) — it becomes `data-site`.
5. Their login email (becomes `ALLOWED_EMAIL`), and whether anyone else will use the bar.
6. A Fly app name (global, e.g. `agent-keyboard-<their-name>`) and region (`fly platform regions`).

Check the repo exists and note whether it's private: `gh repo view OWNER/NAME --json visibility,defaultBranchRef`.

## 2. Supabase (SELF_HOSTING.md step 2)

They create the project at supabase.com (region near the Fly region) and give you the project ref
(the `xxxx` in `https://xxxx.supabase.co`). Then offer two paths:

**A. They paste a Supabase access token** (supabase.com/dashboard/account/tokens, `sbp_…`). You do it:

```bash
REF=xxxx; SBP=sbp_...           # from the user; don't echo
API=https://api.supabase.com/v1/projects/$REF
# keys → SUPABASE_ANON_KEY (name "anon"), SUPABASE_SERVICE_KEY (name "service_role")
curl -sS -H "Authorization: Bearer $SBP" "$API/api-keys" | jq -r '.[] | "\(.name)"'
# job history table
jq -Rs '{query: .}' server/sql/jobs.sql | curl -sS -X POST "$API/database/query" \
  -H "Authorization: Bearer $SBP" -H "Content-Type: application/json" -d @-
# signups off + redirect URLs (site domain, plus the Fly /welcome page)
curl -sS -X PATCH "$API/config/auth" -H "Authorization: Bearer $SBP" -H "Content-Type: application/json" \
  -d '{"disable_signup":true,"site_url":"https://DOMAIN","uri_allow_list":"https://DOMAIN/**,https://YOUR-APP.fly.dev/**"}'
```

Read the keys into variables with `jq -r '.[] | select(.name=="anon") | .api_key'` (and
`service_role`) rather than printing them.

**B. No token** — walk them through step 2 of `SELF_HOSTING.md` in the dashboard, one item at a
time: Email provider on, **Allow new users to sign up: off**, paste and run `server/sql/jobs.sql` in
the SQL editor, add `https://DOMAIN/**` under Authentication → URL Configuration → Redirect URLs, then
copy the Project URL, anon key and service_role key from Project Settings → API.

Either way, create the owner's user with the admin API (works with signups off). Ask them for a
password, or generate one and tell them to save it:

```bash
curl -sS -X POST "https://$REF.supabase.co/auth/v1/admin/users" \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"email_confirm\":true}" | jq '{id, email}'
```

Verify: `curl -sS "https://$REF.supabase.co/auth/v1/settings" -H "apikey: $ANON_KEY" | jq .disable_signup` → `true`.

## 3. GitHub token (SELF_HOSTING.md step 3)

Send them to github.com/settings/personal-access-tokens/new with exactly:
- Repository access → **Only select repositories** → the site repo(s) **and their
  `agent-keyboard` fork** (step 7b: the server updates itself by pushing to it, so without the fork
  "update yourself" fails with a 403)
- **Contents: Read and write**, **Metadata: Read-only** (auto), **Pull requests: Read and write**
  (sandbox publishing opens a PR)
- Nothing else — **no Workflows**, on purpose
- If the repo is in an org, the org may need to approve the token (org Settings → Personal access tokens)

Verify without touching the repo — 200 means the token can push, 403 means it can't (wrong repo
selection, missing Contents write, or pending org approval):

```bash
curl -s -o /dev/null -w "%{http_code}\n" -u "x-access-token:$GH_TOKEN" \
  "https://github.com/OWNER/NAME.git/info/refs?service=git-receive-pack"
```

## 4. Claude token (SELF_HOSTING.md step 4)

They run `claude setup-token` in their own terminal (it's interactive) and paste the `sk-ant-oat…`
token. Verify: `CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_TOKEN" claude -p "reply ok"` prints `ok`.

## 5. SITES

Build it, then validate with `jq`:

```bash
SITES='[{"id":"ID","repo":"https://github.com/OWNER/NAME.git","branch":"BRANCH","domain":"DOMAIN","sandbox":{"preview":"https://{branch}--NETLIFY-SITE.netlify.app"}}]'
echo "$SITES" | jq -e 'length > 0 and all(.[]; .id and .repo and .branch and .domain)'
```

Sandboxes (see "Sandboxes" in `SELF_HOSTING.md`): explain that `sandbox` makes them *available* — the
agent offers one for bigger changes and the user picks "Build in a sandbox" or "Just do it live" each
time; small changes go straight live. Nothing is forced. They need:
- **Netlify:** the site name (the part before `.netlify.app`, in Site configuration → General) and
  **Branch deploys: All** under Build & deploy → Branches and deploy contexts. If `netlify` CLI is
  logged in, `netlify sites:list` shows the name.
- **Host serves branches at subdomains of their domain:** `"sandbox": {}`.
- **Vercel / other:** their host's branch-preview URL pattern with `{branch}` (= `ak-<slug>`).
- If they don't want sandboxes, drop the `sandbox` key; every change then pushes straight to `branch`.

## 6. Email (only if others will use the bar)

Read "Email: set up Resend" in `SELF_HOSTING.md`. Recommend it from the start when anyone besides the
owner will use the bar: Supabase's built-in mailer sends only about 2 invites an hour, and @mentions
fail without `RESEND_API_KEY` + `EMAIL_FROM`. If they skip it, say so and move on.

## 7. Fly (SELF_HOSTING.md step 5)

```bash
fly launch --no-deploy --config server/fly.toml     # pick the app name from step 1; let it rewrite `app =`
fly volumes create agent_data --size 3 --region REGION -a APP   # name must be agent_data
fly secrets set -a APP \
  SUPABASE_URL="https://$REF.supabase.co" SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_KEY="$SERVICE_KEY" \
  ALLOWED_EMAIL="$EMAIL" GH_TOKEN="$GH_TOKEN" CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_TOKEN" \
  AK_INTERNAL_SECRET="$(openssl rand -hex 32)" AK_PUBLIC_URL="https://APP.fly.dev" \
  SITES="$SITES" --stage
```

Add `OPENAI_API_KEY` (voice) and `RESEND_API_KEY` / `EMAIL_FROM` if they have them. `--stage` holds the
secrets until the first deploy:

```bash
flyctl deploy . --config server/fly.toml --dockerfile server/Dockerfile --remote-only -a APP
```

If `fly launch` asks to deploy or set up databases, say no. Don't commit the `fly.toml` rename unless
they want their fork to carry it.

## 7b. Self-updates (don't skip)

So that "update Agent Keyboard to latest" works from any site's bar later, the server needs to know its
own fork and to be able to deploy it. Without this, every new version means a terminal.

1. Their clone must be a GitHub fork they own (`gh repo fork --remote` if it's a plain clone of
   upstream), with the `fly.toml` app rename committed and pushed to its `main`.
2. `AK_FORK_REPO=OWNER/agent-keyboard` (a Fly secret). Every site's agent may then update that fork.
   `GH_TOKEN` must reach it (step 3): re-run the 200/403 check against the fork.
3. One deploy token, used twice: as a Fly secret (self-ops) and as the fork's repo secret (the CI
   autodeploy in `SELF_HOSTING.md` step 6, which ships the update after the agent pushes).
4. GitHub leaves Actions **off** on forks until the owner turns them on once. Have them open
   `https://github.com/OWNER/agent-keyboard/actions` and click **I understand my workflows, go ahead and
   enable them**. Until then a push deploys nothing.

```bash
FLY_TOKEN=$(fly tokens create deploy -a APP)
fly secrets set -a APP FLY_API_TOKEN="$FLY_TOKEN" AK_FORK_REPO="OWNER/agent-keyboard"
gh secret set FLY_API_TOKEN --repo OWNER/agent-keyboard --body "$FLY_TOKEN"
```

`FLY_APP_NAME` doesn't need setting; Fly sets it on every machine.

## 8. Verify and hand over

```bash
curl -sS https://APP.fly.dev/health                       # {"ok":true,"service":"agent-keyboard"}
curl -sSI https://APP.fly.dev/widget.js | head -1          # HTTP/2 200
fly logs -a APP --no-tail | tail -40                       # no "missing" errors; read any warnings
```

Then give them the line to paste before `</body>` (step 7 of `SELF_HOSTING.md`; `data-site` must equal
the id, and the page must be served from `domain`):

```html
<script src="https://APP.fly.dev/widget.js" data-site="ID" defer></script>
```

Offer to add it to their site's repo for them if it's cloned locally. Finish with step 8 ("First run"):
sign in with the email and password from step 2, and ask for something small. Mention the optional CI
autodeploy (step 6) and delete `~/.agent-keyboard-setup.env`.
