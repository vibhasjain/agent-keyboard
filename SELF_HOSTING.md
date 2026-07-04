# Self-hosting Agent Keyboard

A fork-to-working-bar walkthrough. Target: a competent developer gets from `git clone` to a live bar
that edits one of their sites in **under an hour**. Most of that time is waiting on Fly builds.

You will run your own server (on Fly.io) and your own Supabase project. The bar then edits repos you
own and pushes to them; wherever those repos deploy from (Netlify, Vercel, GitHub Pages, …) redeploys.

**What you need to sign up for**

Everything except the Claude subscription has a usable free tier. The Claude subscription is the one
real cost, and it's what actually does the editing.

- [ ] **[GitHub](https://github.com)** — holds your site repos and issues the fine-grained push token.
  You almost certainly have this already.
- [ ] **A [Claude](https://claude.ai) Pro or Max subscription** — `claude setup-token` mints the OAuth
  token the server's CLI authenticates with. This is the cost that matters.
- [ ] **[Supabase](https://supabase.com)** — auth (your one login) and optional durable job history.
  Free tier is fine.
- [ ] **[Fly.io](https://fly.io)** — hosts the server and the durable checkout volume. This guide
  prescribes Fly and the committed config targets it; a Dockerfile exists if you're determined to run
  elsewhere, but you're on your own there. Fly is usage-billed — see the cost note in
  [step 5](#5-flyio-deploy-the-server-15-min).
- [ ] **A static-site host you already use** — [Netlify](https://netlify.com),
  [GitHub Pages](https://pages.github.com), [Cloudflare Pages](https://pages.cloudflare.com), or
  similar: whatever redeploys your repo when the agent pushes. **Agent Keyboard does not host your
  site** — it only edits the repo and pushes; your existing host does the deploy.

You'll also want **`flyctl`** installed, and (for local dev only) **Node 22+**. Each site you point the
bar at must be a git repo that host deploys from a branch.

Times below are rough and assume you have the accounts already.

---

## 1. Clone and look around (2 min)

```bash
git clone https://github.com/vibhasjain/agent-keyboard.git
cd agent-keyboard
```

- `server/` — the API and CLI runner you'll deploy to Fly.
- `widget/` — the embed bundle; baked into the server image at build time.
- `site/` — this project's own marketing site. You don't need it; it's here because the site
  dogfoods the bar.

---

## 2. Supabase: auth + job history (10 min)

The widget authenticates you with Supabase and sends the resulting JWT to your server, which checks it
belongs to your one allowed email. Supabase also (optionally) stores a durable record of each job so
the bar can re-attach after a reload.

1. Create a new project at [supabase.com](https://supabase.com). Pick a region near your Fly region.
2. **Authentication → Providers:** leave **Email** enabled; disable every other provider you don't
   want.
3. **Authentication → Sign In / Providers (or Settings):** turn **off** "Allow new users to sign up".
   This matters: the anon key ships inside the public widget bundle, so anyone can hit your Supabase
   auth endpoint. With signups off, the only account that can ever exist is the one you create by hand.
4. **Authentication → Users → Add user:** create a user with an email + password — your login for the
   bar. Want to give someone else access (a client whose site you built, a partner)? Add a user for
   them too, and list every address in `ALLOWED_EMAIL`, comma-separated. Access is exactly that list;
   nothing else can sign in.
5. **SQL Editor:** open [`server/sql/jobs.sql`](./server/sql/jobs.sql) from this repo, paste it, run
   it. It creates `agent_keyboard_jobs` with row-level security enabled and **no policies** — meaning
   no anon or authenticated client can read or write it; only your server (using the service key,
   which bypasses RLS) touches it. Skipping this just disables durable job history; the bar still
   works.
6. **Project Settings → API:** copy three values —
   - **Project URL** → `SUPABASE_URL`
   - **anon / public key** → `SUPABASE_ANON_KEY`
   - **service_role key** → `SUPABASE_SERVICE_KEY` (secret; enables job history)

---

## 3. GitHub token: push access, tightly scoped (5 min)

The server clones and pushes your site repos with a fine-grained personal access token.

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate
   new token**.
2. **Repository access → Only select repositories:** pick *exactly* the repos you'll list in `SITES`.
   Nothing else.
3. **Permissions → Repository permissions:**
   - **Contents:** Read and write (clone, commit, push).
   - **Metadata:** Read-only (auto-selected).
   - Leave **everything else off** — in particular do **not** grant **Workflows**.
4. Generate; copy the token → `GH_TOKEN`.

Why no Workflows permission: without it, GitHub rejects any push that adds or edits files under
`.github/workflows/`. That caps the agent's blast radius — even with permissions bypassed in the VM, it
cannot rewrite your CI to do something else. Leave it off on purpose.

---

## 4. Claude Code token (2 min)

The server runs the actual Claude Code CLI, authenticated as you.

```bash
claude setup-token
```

This requires a Claude Pro or Max subscription. It prints a token → `CLAUDE_CODE_OAUTH_TOKEN`. The
server never reads this value itself; it's consumed directly by the CLI it spawns. If it's missing the
server still boots (and warns), but every job will fail because the CLI can't authenticate.

---

## 5. Fly.io: deploy the server (15 min)

Everything runs in one small Fly app with one volume.

1. **Install + log in:**
   ```bash
   # https://fly.io/docs/flyctl/install/
   flyctl auth login
   ```
2. **Launch (don't deploy yet).** From the repo root:
   ```bash
   fly launch --no-deploy --config server/fly.toml
   ```
   Fly app names are global, so pick a unique one — e.g. `agent-keyboard-yourname`. Let it update the
   `app = ` line in `server/fly.toml` (or edit it yourself). Everywhere below, `YOUR-APP` is that name.
3. **Create the volume.** The checkout dir and Claude session files live here and must survive
   restarts. It's mounted at `/data` (which is also `HOME`):
   ```bash
   fly volumes create agent_data --size 3 --region <your-region> -a YOUR-APP
   ```
   The name **must** be `agent_data` — that's what `server/fly.toml` mounts.
4. **Set secrets.** `SITES` is the fiddly one — it's JSON with quotes, so wrap the whole value in
   single quotes so your shell passes it through intact:
   ```bash
   fly secrets set -a YOUR-APP \
     SUPABASE_URL="https://YOURPROJECT.supabase.co" \
     SUPABASE_ANON_KEY="eyJhbGciOi..." \
     SUPABASE_SERVICE_KEY="eyJhbGciOi..." \
     ALLOWED_EMAIL="you@example.com" \
     GH_TOKEN="github_pat_..." \
     CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat..." \
     OPENAI_API_KEY="sk-..." \
     SITES='[{"id":"blog","repo":"https://github.com/you/blog.git","branch":"main","domain":"blog.example.com"}]'
   ```
   `OPENAI_API_KEY` is optional (voice); omit it to leave voice off. `GEMINI_API_KEY` is optional
   too — set it to enable the built-in image-generation skill (`fly secrets set -a YOUR-APP
   GEMINI_API_KEY="AIza..."`). Non-secret tuning vars (`CLAUDE_MODEL`, `AK_PUBLIC_URL`, `PORT`, …)
   can go in the `[env]` block of `server/fly.toml` instead — set `AK_PUBLIC_URL` to
   `https://YOUR-APP.fly.dev` so user-provisioning invite emails land on your `/welcome` page.

   > Upgrading an existing deployment? Run `fly ssh console -a YOUR-APP -C "ls -la /data/.claude"`
   > first — the server now loads user-level Claude settings/skills from the volume
   > (`--setting-sources user,project`), so anything already sitting in `/data/.claude` starts being
   > honored after this deploy.
5. **Deploy.** The build context **must** be the repo root so the Dockerfile's widget stage can bake
   `widget/` into the image:
   ```bash
   flyctl deploy . --config server/fly.toml --dockerfile server/Dockerfile --remote-only -a YOUR-APP
   ```
6. **Check it's up:**
   ```bash
   curl https://YOUR-APP.fly.dev/health          # → {"ok":true,"service":"agent-keyboard"}
   curl -I https://YOUR-APP.fly.dev/widget.js     # → 200, content-type text/javascript
   ```
   If the server can't find a required var it exits at boot; `fly logs -a YOUR-APP` will name the
   missing one.

### Cost, and the always-on trade-off

Fly bills for usage. The committed `server/fly.toml` keeps **one machine always running**
(`auto_stop_machines = "off"`, `min_machines_running = 1`) on purpose: jobs are fire-and-forget, so
they keep running server-side after you close the tab. If Fly stopped an idle-looking machine mid-job,
that detached job would die. That always-on small VM (a `shared-cpu-2x` with 2 GB) is what costs
money — on the order of a few dollars a month.

If you'd rather pay less and don't need the guarantee, set `auto_stop_machines = "stop"` (and
optionally `min_machines_running = 0`) in `server/fly.toml`. The machine then sleeps when idle and
wakes on the next request. The trade-offs: a job still in flight when you close the tab can be killed
when the machine stops, and the first request after a sleep is slower while the machine boots. For a
bar you poke a few times a day and watch to completion, that can be a fine trade; for true
fire-and-forget, leave it always-on.

---

## 6. CI autodeploy (optional, 3 min)

The included workflow `.github/workflows/agent-keyboard-deploy.yml` redeploys on any push to `main` that
touches `server/**` or `widget/**`. It deploys whichever app `server/fly.toml` names — which you renamed
in step 5 — so the only thing your fork needs is the token:

```bash
fly tokens create deploy -a YOUR-APP          # prints an app-scoped deploy token
gh secret set FLY_API_TOKEN --body "<that token>"
```

Now `git push` handles deploys. Without this you just re-run the `flyctl deploy` command from step 5 by
hand.

---

## 7. Embed the bar on your site (2 min)

Add one line before `</body>` on any page of a site whose repo is in `SITES`:

```html
<script src="https://YOUR-APP.fly.dev/widget.js" data-site="blog" defer></script>
```

Two things must line up or the bar won't work:

- **`data-site` must equal a `SITES` id** (`"blog"` above).
- **The page's domain must equal that site's `domain`** in `SITES`. CORS only allows the site's own
  `https://domain` and `https://www.domain` (plus `localhost` for dev, plus anything in
  `EXTRA_ORIGINS`). If your page is served from a different host, add it to `EXTRA_ORIGINS`.

`data-api` is optional and defaults to the script's own origin, so you normally don't set it.

---

## 8. First run (2 min)

1. Load the page. The bar appears at the bottom.
2. Tap it, then sign in with the Supabase email + password from step 2.
3. Ask for something trivial and safe — "change the footer year to 2026".
4. Watch the ticker: *syncing → thinking → editing →* the streamed reply.
5. The agent commits as `Agent Keyboard` and pushes to your branch. Check the repo's commit history.
6. Your host redeploys on the push; the live change lands in a minute or so.

Close the tab mid-job and reopen it — the bar re-attaches to the running job. That's the
fire-and-forget path working.

---

## Harness controls: configure the agent by asking it

There is no settings UI. The agent's own runtime is steered in the same chat:

- **Introspection** — "what model are you on?", "how much context are we using?" (approximate).
- **Model / effort** — "switch to sonnet", "set effort to max" (`low·medium·high·xhigh·max`).
  Applied from the next message.
- **Plan mode** — "switch to plan mode" makes the next turns propose without committing; "go back to
  dangerously bypass permissions" leaves it (the agent can exit plan mode even though it can't edit
  files there — the server handles it).
- **Compact** — "compact your memory" compresses the conversation right after the current turn.
- **Skills** — "install a skill that does X" writes to `/data/.claude/skills`; it loads next turn and
  survives deploys. Three skills ship built in: `image-gen` (needs `GEMINI_API_KEY`),
  `verify-in-browser` (headless Chromium is preinstalled), `provision-user` (below).

State lives in `/data/agent-keyboard/sites/<id>/settings.json`. If the agent ever wedges its own
settings, reset from your machine:

```bash
fly ssh console -a YOUR-APP -C "rm /data/agent-keyboard/sites/<id>/settings.json"
```

### Inviting more users

Ask the bar: *"invite esther@example.com"*. The agent runs the `provision-user` skill — Supabase
emails them a link to set a password (landing on `$AK_PUBLIC_URL/welcome`), and their email is added
to `/data/agent-keyboard/allowed-emails.json`, which the auth gate accepts alongside `ALLOWED_EMAIL`.

Setup requirements, once:

1. `SUPABASE_SERVICE_KEY` must be set (it's the same key durable jobs use).
2. Add `https://YOUR-APP.fly.dev/welcome` to Supabase **Auth → URL Configuration → Redirect URLs**.
3. Don't set `ALLOWED_USER_ID` — it pins auth to specific user ids and blocks provisioned users.

Revoke someone by removing their email from the JSON file (`fly ssh console`), or deleting the user
in Supabase.

### Branded invite emails (optional, free)

By default Supabase sends invites from its own shared address with a generic template (and a
couple-per-hour rate limit). To send branded emails from your own domain instead: create a free
[Resend](https://resend.com) account, verify your domain (3 DNS records), plug Resend's SMTP
credentials into Supabase (Project Settings → Auth → SMTP), and paste the templates from
[`server/email-templates/`](./server/email-templates) into Auth → Email Templates. Details in that
directory's README. No code changes — the provision-user flow just starts sending branded emails.

---

## A review step instead of straight-to-main

By default the agent pushes to your deploy `branch`, so an accepted change goes live on the next
redeploy. If you'd rather look before it ships, add an optional `pushBranch` to that site's `SITES`
entry. The agent then commits as usual but publishes to `pushBranch` — a branch your host does **not**
deploy from — and nothing goes live until you merge it yourself (open a PR from it, review, merge).

```jsonc
{ "id": "blog", "repo": "https://github.com/you/blog.git", "branch": "main",
  "domain": "blog.example.com", "pushBranch": "agent-keyboard/{ts}" }
```

- `pushBranch` must differ from `branch`. Everything else about a job is unchanged — the checkout still
  syncs from your live `branch` each turn, so every change starts from what's actually deployed.
- A `{ts}` placeholder is replaced with a UTC timestamp per job (`agent-keyboard/20260702-181500`),
  giving each change its own branch — clean for one-PR-per-change review, and it never needs a force
  push. A static name like `"agent-keyboard"` keeps a single rolling review branch instead (the agent
  force-updates it each turn; that branch is agent-only, so nothing else is clobbered).
- The reply names the branch it pushed to, so you can tell at a glance that a change is staged for
  review rather than live.

This is a safety valve, not a full PR workflow — the agent publishes the branch; opening and merging
the PR is on you.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Server exits at boot, log names a var | A required var is unset | Set it: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ALLOWED_EMAIL`, `SITES`, `GH_TOKEN`. |
| Widget console: "Server did not inject Supabase config" | `SUPABASE_URL` / `SUPABASE_ANON_KEY` not set, so the served bundle kept its placeholders | Set both on the server and redeploy. |
| Bar loads but requests are CORS-blocked | The page's domain doesn't match the site's `domain` in `SITES` | Fix the `domain`, or add the page's origin to `EXTRA_ORIGINS`. |
| 401 on login | Wrong email/password, or the user doesn't exist, or signups left on and you signed up a different address | Confirm the user in Supabase; the login email must equal `ALLOWED_EMAIL`. |
| Tapping the mic goes *connecting* then errors | No `OPENAI_API_KEY`, so the server refuses to mint voice tokens | Set it and redeploy. (The mic button is always shown; only token minting is gated.) |
| Job runs but push is rejected | `GH_TOKEN` lacks the repo, lacks Contents write, or the push touched `.github/workflows/` | Add the repo to the token's selection / grant Contents write. Workflow files are blocked by design. |
| Job history / re-attach doesn't persist across restarts | No `SUPABASE_SERVICE_KEY` | Set the service_role key and redeploy; re-run `server/sql/jobs.sql` if you skipped it. |
| Everything works but the agent errors immediately | `CLAUDE_CODE_OAUTH_TOKEN` missing or expired | Re-run `claude setup-token` and update the secret. |
| "Image generation isn't configured" | No `GEMINI_API_KEY` | `fly secrets set GEMINI_API_KEY=...` and redeploy. |
| Agent stuck in plan mode / weird settings | Its `settings.json` got wedged | Ask it to "go back to dangerously bypass permissions" (works from plan mode), or `fly ssh console -C "rm /data/agent-keyboard/sites/<id>/settings.json"`. |
| Invite email link lands somewhere useless | `/welcome` isn't in Supabase's allowed redirect URLs, or `AK_PUBLIC_URL` unset | Add `https://YOUR-APP.fly.dev/welcome` to Auth → URL Configuration and set `AK_PUBLIC_URL`. |
| Provisioned user still gets 401 | `ALLOWED_USER_ID` is set (pins auth to specific ids) | Unset it, or add the new user's Supabase UUID. |

---

Back to the [README](./README.md) · widget internals in [widget/README.md](./widget/README.md).
