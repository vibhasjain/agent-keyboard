---
name: self-host
description: Set up a self-hosted Agent Keyboard server end to end with the user — their site (existing, or a new one from an empty repo, including hosting and the domain's DNS), Supabase, GitHub token, Claude token, Fly.io deploy, SITES config, and the script tag. Use when someone has cloned the agent-keyboard repo and asks to set up, install, self-host, or deploy Agent Keyboard (or "get the bar working on my site"). Not for operating an already-running instance (that's self-ops).
---

# Set up a self-hosted Agent Keyboard

You're running on the user's own machine, in a clone of `agent-keyboard`. `SELF_HOSTING.md` is the
source of truth: follow its numbered steps in order, read each section before doing it, and do the work
with the user rather than handing them the doc. This file only adds what the doc can't: the order of
questions, the commands that verify each step, and the pitfalls.

Rules:
- **One question per message.** Never send a numbered questionnaire. Work out whatever you can
  yourself and offer it as a default the user can just confirm ("I'll call it `blog`, OK?").
- One step at a time. Say what's next in a sentence, verify it, move on.
- **Tokens never go through the chat.** Prefer browser logins (`flyctl auth login`, `gh auth login`,
  `netlify login`, `wrangler login`): the CLI keeps the credential and you never see it. For the
  tokens the server needs (`SBP`, `GH_TOKEN`, `CLAUDE_TOKEN`, `PASSWORD`), have the user run this **in a
  separate terminal window** (your shell can't take hidden input), with NAME filled in (`bash -c` so it works from zsh too; `%q` keeps odd characters safe to `source`):

  ```bash
  bash -c 'read -rsp "Paste NAME, then Enter: " v && echo && umask 077 && printf "NAME=%q\n" "$v" >> ~/.agent-keyboard-setup.env && echo saved'
  ```

  If they paste a token into the chat anyway, tell them to revoke it and make a new one. Use the values
  only via `source ~/.agent-keyboard-setup.env` inside your commands; never `cat` the file or echo a
  value. Delete the file at the end.
- If a check fails, stop and fix it there. Don't carry a broken step forward.
- Don't quote a total time up front. When a slow step starts (the Fly build is several minutes), say
  so then.

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

Ask only these, one at a time, waiting for each answer:
1. "Do you already have a website, or are we starting from scratch?" Scratch → do **1b**, which
   answers the rest.
2. "Which GitHub repo is it?" Offer their recent repos from `gh repo list --limit 10` to pick from.

Then work out the rest yourself and confirm it in one short message ("Here's what I found: … Anything
to change?"), asking only about what you couldn't find:
- Branch: the default branch (`gh repo view OWNER/NAME --json visibility,defaultBranchRef`; note if private).
- Host: from the repo's `netlify.toml` / `vercel.json` / `wrangler.toml` / `fly.toml`, or the repo's
  homepage URL.
- Domain (bare, no `https://`): the repo homepage, the host's CLI if logged in, or a `CNAME` file.
- Site id (becomes `data-site`): the repo name, lowercased.
- Login email (`ALLOWED_EMAIL`): `flyctl auth whoami` or `gh api user --jq .email`.
- Fly app name: `agent-keyboard-<github-username>`; region: the one `fly platform regions` marks
  closest, or `iad`.

Ask whether anyone else will use the bar later, at step 6, not now.

## 1b. No site yet

The bar only appears on a live page, so put one online before anything else.
1. Repo: `gh repo create NAME --private --clone` (or clone their empty one). Commit a minimal
   `index.html` (a title and a line of text is enough; the bar will build the rest) and push.
2. Host: ask which they want; suggest Netlify or Cloudflare Pages (free, branch previews, which
   sandboxes use). Log in with the host's CLI (browser login), create the site connected to the
   GitHub repo so every push to `main` deploys, and confirm the `*.netlify.app` / `*.pages.dev` URL
   serves the page.
3. Domain (if they have one): add it in the host, then tell them the exact DNS record to add at
   their registrar (a subdomain is a CNAME to the host's target; an apex needs the host's ALIAS/A
   records: read the host's docs for the current values). Check with `dig +short DOMAIN` and
   `curl -sI https://DOMAIN`. DNS and the certificate can take a while: carry on with the default
   URL as the domain meanwhile, and change `domain` in SITES later (step 5).

## 2. Supabase (SELF_HOSTING.md step 2)

They create the project at supabase.com (region near the Fly region) and give you the project ref
(the `xxxx` in `https://xxxx.supabase.co`). Then offer two paths:

**A. A Supabase access token** (supabase.com/dashboard/account/tokens, `sbp_…`), saved as `SBP` with the
hidden-input line above. You do the rest:

```bash
source ~/.agent-keyboard-setup.env; REF=xxxx
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

Append the keys to `~/.agent-keyboard-setup.env` as `ANON_KEY` / `SERVICE_KEY` with
`jq -r '.[] | select(.name=="anon") | .api_key'` (and `service_role`) rather than printing them.

**B. No token** — walk them through step 2 of `SELF_HOSTING.md` in the dashboard, one item at a
time: Email provider on, **Allow new users to sign up: off**, paste and run `server/sql/jobs.sql` in
the SQL editor, add `https://DOMAIN/**` under Authentication → URL Configuration → Redirect URLs, then
copy the Project URL, anon key and service_role key from Project Settings → API.

Either way, create the owner's user with the admin API (works with signups off). They choose the
password and save it as `PASSWORD` with the hidden-input line (never ask for it in chat):

```bash
curl -sS -X POST "https://$REF.supabase.co/auth/v1/admin/users" \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" -H "Content-Type: application/json" \
  -d "$(jq -n --arg e "$EMAIL" --arg p "$PASSWORD" '{email:$e, password:$p, email_confirm:true}')" | jq '{id, email}'
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

Save it as `GH_TOKEN` with the hidden-input line.

## 4. Claude token (SELF_HOSTING.md step 4)

They run `claude setup-token` in their own terminal (it's interactive) and save the `sk-ant-oat…`
token as `CLAUDE_TOKEN` with the hidden-input line. Verify: `CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_TOKEN" claude -p "reply ok"` prints `ok`.

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

Ask: "Will anyone besides you use the bar?" No → skip this step.

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

Offer to add it to their site's repo for them if it's cloned locally (from 1b it is: add it, commit,
push). Then `curl -s https://APP.fly.dev/check | jq` should pass every check. Finish with step 8 ("First run"):
sign in with their email and the password they saved in step 2, and ask for something small. Mention the optional CI
autodeploy (step 6) and delete `~/.agent-keyboard-setup.env`.
