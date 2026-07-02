# Security and threat model

Agent Keyboard gives an AI agent push access to a small allow-list of git repositories, driven by a
single authenticated owner. This is the honest long version of the README's
[Security model](./README.md#security-model): what the thing is, what an attacker who finds your
server can and cannot do, where the trust boundaries sit, and the risks that remain after all of them.

The posture is "one trusted human, tightly scoped credentials," not "multi-tenant SaaS." Every claim
below is verifiable against the code (`server/src/auth.ts`, `index.ts`, `checkouts.ts`, `claude.ts`).

## What this is

- One Express server you host (the reference deploy is Fly.io) that drives the real Claude Code CLI
  against per-site git checkouts.
- A single owner: every privileged request must carry a Supabase JWT that resolves to one configured
  email (`ALLOWED_EMAIL`). There are no other accounts, and Supabase signups are turned off, so no
  other account can be created.
- A fixed allow-list of repos (`SITES`) the agent may edit. It cannot be pointed at an arbitrary repo.
- The agent edits a checkout, commits as `Agent Keyboard`, and pushes; your existing host redeploys.
  The server hosts nothing of yours.

## What an unauthenticated attacker can and cannot do

Someone who finds your server's URL, with no valid session:

**Can:**
- `GET /health` — a static liveness JSON.
- `GET /widget.js` — the public embed bundle. It carries your `SUPABASE_URL` and Supabase **anon**
  key, both public by design (the anon key gates nothing on its own; Supabase RLS and the owner check
  do). It is served with `Access-Control-Allow-Origin: *` on purpose.

**Cannot** — each of these returns 401 without an owner token:
- `GET /sites`, `POST /sites/:id/messages` (start a job), `POST /sites/:id/uploads` (attach a photo),
  `GET /sites/:id/conversation`, `GET /jobs`, `GET /jobs/:id`, `GET /jobs/:id/stream`,
  `POST /realtime/token`.

No token means the Claude Code CLI is never spawned — there is no code path that runs the agent for an
unauthenticated request. `requireOwner` (`server/src/auth.ts`) verifies the JWT against Supabase and
requires the resulting email to equal `ALLOWED_EMAIL` (optionally pinned to `ALLOWED_USER_ID`);
anything else is rejected.

Rejecting an unauthenticated request is deliberately cheap: a missing token is a bare 401 with no
I/O, and a token that isn't even shaped like a JWT is rejected locally without an outbound call. Only a
well-formed-but-unrecognized token costs one Supabase `/auth/v1/user` lookup (rate-limited by Supabase
itself), and the per-token verification cache is size-bounded so a flood of unique tokens can't grow
server memory without limit.

**CORS is not the gate.** Allowed browser origins are derived from your `SITES` domains
(`https://domain` and `https://www.domain`) plus `EXTRA_ORIGINS` and localhost (`server/src/index.ts`).
CORS only decides whether a *browser* lets a cross-origin page read a response; a raw client with no
`Origin` bypasses it. The real boundary is the owner JWT check, which every privileged route enforces
regardless of origin.

## The four rings

Same rings as the README, outermost in:

1. **Single-owner gate.** Every privileged request carries a Supabase JWT that must resolve to
   `ALLOWED_EMAIL` (optionally `ALLOWED_USER_ID`). No other accounts exist; signups are off, so none
   can be made.
2. **The `SITES` allow-list.** The agent only ever operates on a repo you listed. An unknown site id
   is a 404; there is no "edit an arbitrary repo" path, and each checkout lives at a fixed, hardcoded
   path on the volume.
3. **VM-bounded bypass + a scoped token.** The CLI runs with `bypassPermissions`, but inside a
   dedicated VM. The most it can reach is the `/data` volume and whatever `GH_TOKEN` allows — a
   fine-grained PAT scoped to only the `SITES` repos, Contents read/write, and **no** workflows
   permission. GitHub then rejects any push that touches `.github/workflows/`.
4. **No secret in the browser.** The anon key is public by design. Voice dictation uses short-lived
   OpenAI tokens minted server-side (`POST /realtime/token`, owner-only). The Claude OAuth token,
   `GH_TOKEN`, and Supabase service key live only in your server's secrets.

## Prompt injection

The agent's inputs come only from the authenticated owner. There is no crawler, no page-DOM scraping,
no third-party content path into the prompt:

- The prompt is built (`server/src/claude.ts`) from the owner's typed or dictated `text`, the page
  path it was sent from (a `[Sent from https://domain/path]` context line), and any photos the owner
  attached through the authed upload route. Those photos are the owner's own inputs.
- A page visitor cannot inject anything into the agent — they have no session, and page content is
  never read into the prompt.
- One nuance: the agent reads the *target repo's own files* (including its `CLAUDE.md`) as it works.
  So trust in the agent's instructions equals trust in whoever can commit to that repo. For a solo
  owner editing their own sites, that is the same person; if a site repo has other writers, treat
  their committed content as something the agent may act on.

## What a push can touch

- **Only `SITES` repos.** The PAT is scoped to just those repositories; the agent holds no credential
  for anything else.
- **No workflow files.** The PAT has no workflows permission, so GitHub rejects any push that adds or
  edits `.github/workflows/` — the agent cannot rewrite your CI.
- **Deploy history stays append-only (recommended control).** This server never force-pushes your
  deploy branch, and each turn starts from a clean reset of `origin/<branch>`. To make that a
  guarantee rather than a convention, protect the deploy branch with a GitHub ruleset that blocks
  force-pushes and deletions. (If you enable a `pushBranch` review branch, note that a *static* review
  branch is agent-only and may be force-updated by the agent — it never deploys, and your deploy
  branch is untouched.)
- **Every change is an attributable commit.** Commits are authored and committed as `Agent Keyboard`;
  your git history is the audit trail of everything the agent did.

## Residual risks, stated plainly

- **A compromised owner account is game over.** The single Supabase login is the whole gate. Use a
  strong, unique password and keep signups disabled so no second account can exist. Because the anon
  key ships in the public widget, anyone can *reach* your Supabase auth endpoint — so the password and
  Supabase's own rate limiting are doing real work.
- **A leaked `GH_TOKEN` is bounded:** contents-write on only the listed repos, no workflows, no other
  scope. Rotate it with `fly secrets set GH_TOKEN=…`; the next job picks up the new value.
- **A leaked `CLAUDE_CODE_OAUTH_TOKEN`** lets someone use your Claude subscription. It lives only in
  server secrets; rotate with `claude setup-token` and update the secret.
- **All sites share one VM and one `/data` volume.** Separation between site checkouts is the agent's
  cooperation plus a per-site mutex, not a hard sandbox. Since only the one owner can issue prompts,
  this is about owner error, not external attack — but if you don't want two sites sharing a blast
  radius, run two deployments.
- **Your prompts become commit messages.** If a target repo is public, what you typed is visible in
  its history. Don't put secrets in prompts.

## Reporting a vulnerability

Please don't open a public issue for a security problem. Instead:

Open a private [GitHub Security Advisory](https://github.com/vibhasjain/agent-keyboard/security/advisories/new)
on this repository — it reaches the maintainer directly. This is a personal, single-owner project
with no security team; best-effort response, usually fast.

Because this is a self-hosted, single-owner tool, the most valuable hardening is usually your own
configuration: signups off, a strong Supabase password, a tightly scoped PAT, and a protected deploy
branch.
