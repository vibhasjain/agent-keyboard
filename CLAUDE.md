# Agent Keyboard — a prompt bar that edits the site it's on

> One script tag turns any static site into something you can change by asking. Type, dictate, or
> photograph a change; a real Claude Code session edits the site's own repo and pushes to `main`.

This file orients any agent (or human) working in this repo. Read it before touching code.

---

## What Agent Keyboard is (shipped, real)

A floating **prompt bar** you embed on a static site with a single `<script>` tag. The site's owner
taps the bar, signs in, and asks for a change — by typing, holding to dictate, or attaching a
photo. The request goes to a small server that drives the **real Claude Code CLI** against a durable
git checkout of that site's repo, makes the edit, commits as `Agent Keyboard`, and **pushes to
`main`**. Wherever the site already deploys from (Netlify, etc.) redeploys. The bar streams every
step live and is **fire-and-forget**: close the tab and the job keeps running server-side; reopen and
it re-attaches to the stream.

There is no SDK, no app-crawler, no vision/computer-use, and no per-app "action layer" — that was the
earlier pitch (see history below). The product is: **ask → edit the repo → ship.**

It is **open source (MIT)** at **github.com/vibhasjain/agent-keyboard** and **self-hostable** — anyone
with a Claude Code subscription can fork it, point the `SITES` allow-list at their own repos, and run
their own server. See `README.md` and `SELF_HOSTING.md`.

---

## Repo layout

| Dir | What it is | Ships via |
|-----|-----------|-----------|
| `site/` | The marketing site at **agentkeyboard.com**. `index.html` (positioning + the live widget embedded with `data-site="halo"`, so the page edits itself) and `agent-keyboard-flight-prototype.html` (the original vision film, kept for posterity). | **Netlify** — `netlify.toml` publishes `site/`; autodeploys on push to `main`. |
| `server/` | The API. Express + `tsx`, deployed to the **Fly app `agent-keyboard`** (`server/fly.toml`). Serves `/widget.js`, runs the Claude Code CLI against per-site checkouts, streams SSE. | **Fly.io** — see Deploy. |
| `widget/` | The embeddable bundle (TypeScript, zero runtime deps, esbuild → one IIFE `dist/widget.js`, ~15 KB gzip, Shadow-DOM isolated). See `widget/README.md` for internals + the protocol contract. | Baked into the server image (Dockerfile widget stage), served at `/widget.js`. |

## Architecture

```
owner's site ──<script src="…/widget.js" data-site="mysite">──┐
   (widget: bar → compose → SSE)                          │
                                                          ▼
              Fly app "agent-keyboard" (server/) ── auth (Supabase JWT, owner only)
                    │  per-site git checkout on /data volume  (FIXED cwd, session-stable)
                    │  claude -p  (real Claude Code CLI)  → edit → commit → push origin main
                    └─ SSE frames: job · status · assistant · result{git,reply} · error
```

- **Sites allow-list** — the `SITES` env var (a one-line JSON array), parsed by `server/src/sites.ts`.
  The agent may only ever operate on one of these checkouts, never an arbitrary repo. Each entry is
  `{id, repo, branch, domain}`: `id` = the `data-site` slug, `repo` = https clone URL, `branch` = the
  branch the host deploys from, `domain` = bare host (drives CORS + the "[Sent from …]" prompt
  context). e.g. `[{"id":"blog","repo":"https://github.com/you/blog.git","branch":"main","domain":"blog.example.com"}]`.
  This project's own site is served with `data-site="halo"`, so the page edits its own repo.
- **Auth** — `server/src/auth.ts`, `requireOwner()`: a Supabase JWT for the one allow-listed email.
  The widget hand-rolls GoTrue REST (no supabase-js) and stores its session under
  `localStorage['agent-keyboard-auth']`.
- **Durability** — Fly volume mounted at `/data` (= `HOME`) holds the per-site checkouts (fixed cwd
  paths so Claude Code session hashes stay stable) and the session JSONLs (memory + compaction). One
  warm machine keeps the in-process job registry + per-site mutex available.
- **SSE protocol** — the contract the widget speaks: `POST /sites/:id/messages` (response IS the
  stream), `GET /jobs/:id/stream` (re-attach), `GET /jobs?siteId=`, `POST /sites/:id/uploads`
  (multipart `photo`), `GET /sites/:id/conversation`, `POST /realtime/token` (OpenAI ephemeral for
  voice dictation). Frames: `job` · `status{phase,detail}` · `assistant{text}` (full replace) ·
  `result{reply,git,…}` · `error`. Full spec lives in `widget/README.md`.

## Deploy

- **Site** (`site/**`) → push to `main`; **Netlify** redeploys agentkeyboard.com (~30s). No build step.
- **Server + widget** (`server/**` or `widget/**`) → push to `main` triggers
  `.github/workflows/agent-keyboard-deploy.yml` → `flyctl deploy`. Manual equivalent (build context
  MUST be the repo root so the Dockerfile's widget stage can bake `widget/` into the image):
  ```
  flyctl deploy . --config server/fly.toml --dockerfile server/Dockerfile --remote-only -a agent-keyboard
  ```
- **Config** (Fly secrets / env): required — `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ALLOWED_EMAIL`,
  `SITES`, `GH_TOKEN` (push); optional — `CLAUDE_CODE_OAUTH_TOKEN` (read by the CLI, not the server),
  `SUPABASE_SERVICE_KEY` (durable jobs), `ALLOWED_USER_ID`, `OPENAI_API_KEY` (voice), `EXTRA_ORIGINS`
  (extra CORS). CI uses the repo secret `FLY_API_TOKEN`. Full table + defaults in `README.md` /
  `server/.env.example`; non-secret tuning can live in `server/fly.toml`.

---

## Design system (real, and used by the live widget)

### Brand: dark, warm, editorial
| Token | Value | Use |
|-------|-------|-----|
| `--bg` / `--bg-2` | `#0a0a0a` / `#111110` | near-black background / raised surfaces |
| `--ink` / `--ink-2` / `--ink-3` | `#f5f1ea` / `#b8b2a7` / `#6f6a61` | warm off-white / muted / faint text |
| `--rule` | `#211f1c` | hairlines |
| **`--amber`** | **`#ffb86b`** | **primary brand / accent** |
| `--amber-2` / `--amber-deep` | `#f9a26c` / `#c4651a` | accent gradient |
| `--warm` | `#e7d3b8` | italic serif accents |
| `--violet` | `#b794f6` | "thinking" state |
| `--ok` | `#6dd396` | "done" state |

**Agent state colors carry meaning:** syncing = dim, thinking = violet, editing/acting = amber,
done = green, error = `#f97066` (red, outside the palette, used sparingly).

**Brand mark:** a glowing amber orb — `radial-gradient(circle at 32% 28%, #fff5e2, var(--amber) 38%,
var(--amber-deep) 95%)` with a breathing animation. The orb is brand only (favicon, site hero); the
widget's persistent surface is the slim **bar**, which streams in a pill with a live status **ticker**.

### Typography
- **Instrument Serif** — display / wordmark / italic accents.
- **Inter** — body / UI on the marketing site.
- **JetBrains Mono** — labels, code, the status ticker, the mm:ss timer.

### Motion principles
- Respect `prefers-reduced-motion`.
- The ticker keeps **one motion axis at a time** (vertical line-slide OR horizontal word-scroll).
- Warm, breathing, calm. No jank.

---

## Terminology
- **Bar** — the widget's persistent surface (slim composer); streams in a **pill**, expands to the full transcript. The **orb** is the brand mark only, not the trigger.
- **Ticker** — single-line status text: syncing → thinking → editing → the streamed reply.
- **Site** — an allow-listed repo/domain the bar can edit (an entry in the `SITES` env var).
- **Fire-and-forget** — the job survives the browser closing; the bar re-attaches on return.
- **Vision film** — `site/agent-keyboard-flight-prototype.html`, the original scripted prototype.

---

## History (context, not current)
Agent Keyboard began (2026-05) as a pitch for a "drop-in SDK that turns any app's flows into
agent-callable actions" — an action layer an agent could operate by voice, demoed with a scripted
flight-booking film. That vision is preserved as the film linked from the home page. The product that
actually shipped is narrower and real: the prompt bar in this repo that edits static sites via their
own git repos. When editing, describe the **shipped** product, not the old SDK pitch.

## Working agreements
- **Plan first** for non-trivial (3+ step) tasks; verify before marking done — prove it works, don't
  assume. Root-cause fixes, minimal impact, touch only what's necessary.
- **Browser testing** — headless (the `browse`/dev-browser Playwright skill), never chrome MCP tools.
