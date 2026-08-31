---
name: relay
description: Send a task to another Agent Keyboard agent by handle and optionally get a completion report back. Use when asked to relay/delegate/forward work to another site's agent or to report status to the master.
---

# relay

Use the fleet registry through the seeded helper at
`/data/.claude/skills/relay/relay.sh`.

## Handles

| Handle | Target | Guest | Color | Description |
| --- | --- | --- | --- | --- |
| `home` | `main / cv /` | no | `#ffb86b` | vibhasjain.com homepage — THE MASTER ORCHESTRATOR |
| `jobs` | `main / cv-jobs` | no | `#7fb4e8` | career-ops worker (vibhasjain.com) |
| `agentkeyboard` | `main / halo` | no | `#6fd3c7` | agentkeyboard.com — edits Agent Keyboard's own repo |
| `makemepixels` | `main / makemepixels` | no | `#f47fb0` | makemepixels.com |
| `menuplusplus` | `mpp / mpp` | no | `#6dd396` | menuplusplus.com (live agent, fork server) |
| `estherandvibhas` | `main / estherandvibhas /` | no | `#b794f6` | estherandvibhas.com |
| `estherfell` | `main / estherfell /` | yes | `#e8c95a` | estherfell.com |
| `closeoutcopilot` | `main / closeout /` | yes | `#e7d3b8` | closeoutcopilot.com deck |
| `closeoutjobs` | `main / closeout-jobs` | yes | `#9aa7c7` | closeout jobs worker |
| `menuplusplusserver` | `mpp / keyboard` | no | `#ef8e7d` | the Menu Plus Plus Agent Keyboard — edits the MPP fork's own bar/server code |

`home`, `estherandvibhas`, `estherfell`, and `closeoutcopilot` are page-scoped.
Add `:/path` to target a page session; `/` is the default.

## Mentions

When a reply refers to a fleet agent, write the bare handle — `@makemepixels`,
not `` `@makemepixels` `` and not `**@makemepixels**`. The owner's bar renders a
bare mention as that agent's colored tag; backticks make it plain code and lose
the color.

## Send work

Fire-and-forget is the default: it prints the durable job id and disconnects
without stopping the job.

```bash
bash /data/.claude/skills/relay/relay.sh menuplusplus "Check the current batch status" --from home
bash /data/.claude/skills/relay/relay.sh estherandvibhas:/rsvp "Fix the RSVP copy" --reply-to home
```

Use `--reply-to <handle>` when the target should send a completion report. Use
`--wait` for a short task when you need its terminal `result` or `error` inline;
it waits up to 900 seconds unless `--timeout <sec>` overrides that limit.

```bash
bash /data/.claude/skills/relay/relay.sh agentkeyboard "Inspect the current server status" --wait
bash /data/.claude/skills/relay/relay.sh --jobs home:/movies
```

Posting to a busy site simply queues the task FIFO.

## Completion callbacks

Callback turns arrive like normal messages beginning `[relay:done <handle>]`.
When one arrives, summarize it for the owner. Do **not** relay it onward unless
the prompt explicitly asks you to.

Guest handles `estherfell`, `closeoutcopilot`, and `closeoutjobs` have both
relay secrets stripped. They cannot run callbacks: use `--wait` or poll `--jobs`
for work sent to them, and never use a guest handle as `--reply-to`.

`home` is the master orchestrator. Subagents report to it. Only relay when your
prompt asks you to relay.
