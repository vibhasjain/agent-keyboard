# Agent Keyboard widget

The embeddable prompt bar. A single self-contained IIFE that mounts a Shadow-DOM-isolated bar on any
page: a slim composer that streams the agent's progress in a pill, expands into a full terminal-style
transcript, and re-attaches to running jobs after a reload.

- **Zero runtime dependencies.** TypeScript → one `dist/widget.js` via esbuild.
- **~15 KB gzip.** The whole bar — styles, auth, SSE reader, photo upload, voice — ships in that.
- **Shadow-DOM isolated.** Styles are scoped to a shadow root, so the host page can't leak in and the
  bar can't leak out.

## Build

```bash
cd widget
npm i
npm run build     # → dist/widget.js (minified IIFE)
npm run dev       # same, unminified, for debugging
npm run check     # tsc --noEmit
npm run mock      # zero-dep mock server + a hostile host page under dev/
```

`npm run mock` serves a fake API and a deliberately hostile host page (aggressive global CSS, reset
attempts) so you can confirm the Shadow-DOM isolation holds.

## How config resolves

The widget reads its own `<script>` tag and needs no config from the embedder:

- **`data-site`** (required) — the site id; must match an entry in the server's `SITES` allow-list.
  With no `data-site` the widget refuses to mount.
- **`data-api`** (optional) — overrides the API base. Defaults to the origin the script was served
  from, so one server serving both `widget.js` and the API needs nothing here.
- **`data-hide-paths`** / **`data-only-paths`** (optional) — scope which pages the bar appears on
  without editing each one. The bar shows on **every page the embed is on by default**; set
  `data-hide-paths="/admin/,/checkout"` to skip those (a trailing `/` means the whole subtree, `*`
  matches within a path segment, `**` across segments), or `data-only-paths="/blog/**"` to restrict
  it to just those. Handy when the embed lives in a shared template.
- **Supabase URL + anon key** — *not* set by the embedder. The bundle ships with the placeholders
  `__AK_SUPABASE_URL__` / `__AK_SUPABASE_ANON_KEY__`, which the server replaces from its
  `SUPABASE_URL` / `SUPABASE_ANON_KEY` env at serve time. If they're still placeholders (server didn't
  inject them) the widget logs "Server did not inject Supabase config" and won't authenticate.

Auth is hand-rolled GoTrue REST (no `supabase-js`); the session is stored under
`localStorage['agent-keyboard-auth']`.

## Protocol

The widget talks to the server over a small HTTP + SSE contract. Auth is a `Bearer <jwt>` header on
every request (which is why the streams use a fetch-based reader, not `EventSource` — it can't carry
headers).

### Endpoints

| Method + path | Purpose |
|---------------|---------|
| `POST /sites/:id/messages` | Send a prompt (`{text, page, idemKey, attachmentIds?}`). **The response IS the SSE stream.** A duplicate `idemKey` re-tails the original job. |
| `GET /jobs/:jobId/stream` | Re-attach to a running or finished job; replays current state, then live frames. |
| `GET /jobs?siteId=` | List active jobs plus a short finished window for a site. |
| `POST /sites/:id/uploads` | Upload one photo (multipart, field `photo`, ≤15 MB) → `{id, path}` to attach. |
| `GET /sites/:id/conversation` | Chat history (`?limit`, `?before`) from the agent's durable session. |
| `POST /realtime/token` | Mint a short-lived OpenAI realtime token for voice dictation. |

### SSE frames

Each frame is `event: <name>\ndata: <json>\n\n`. Comment lines (`: ka`) are keepalives and ignored.
Over one job's stream you'll see:

| Frame | Payload | Meaning |
|-------|---------|---------|
| `job` | `{job_id, target, status}` | Job opened; carries its id for re-attach. |
| `status` | `{phase, detail}` | Progress line: syncing → thinking → editing (→ compacting). Rendered in the ticker. |
| `assistant` | `{text}` | The streaming reply. **Full replace** — each frame is the complete text so far, not a delta. |
| `result` | `{reply, git, usage, …}` | Terminal success: the final reply plus git info (`changed`, `pushed`, `headSha`, `branch`) and `usage` (`cost_usd`, `duration_ms`, `context_tokens`, `context_pct` — approximate — and `model`). |
| `error` | `{kind, detail}` | Terminal failure (`server_error`, `not_found`, `interrupted`, …). |

### Reliability behaviors (client-side)

- **Durable outbox** — queued and in-flight sends persist to `localStorage` (`ak:<site>:outbox`) and
  are re-sent after a reload with their original `idemKey`, which the server re-tails instead of
  re-running (10-min window). Sends queue while a job runs and dispatch in order.
- **Orphan discovery** — boot and first-expand call `GET /jobs?siteId=` to attach to a running job
  this device doesn't have a persisted key for (cleared storage, another device), filtered through
  the handled-jobs ledger.
- **Transcript reconciliation** — turns completed this page load are deduped against fetched history
  by normalized user-turn text, and the tail is refetched on re-expand, so a turn never renders twice
  and ordering stays canonical.

## Size budget

The bar is meant to be a nearly-free addition to a page — currently ~15 KB gzip, with a hard 30 KB
gzip budget enforced by `build.mjs`: no runtime dependencies, no framework. Check the size `npm run
build` prints if you add anything heavy.

---

Project overview: [../README.md](../README.md) · self-hosting: [../SELF_HOSTING.md](../SELF_HOSTING.md).
