---
name: fable-subagents
description: Fable-as-orchestrator workflow — one main Fable agent thinks and plans at task-appropriate effort while all execution fans out to explicitly-routed subagents (Sonnet for routine work, Opus for hard execution, GPT 5.6-sol at ultra effort via Codex for all design and coding work). Use whenever running on Fable 5 and the task involves execution work that subagents can do — implementation, drafting, content batches, UI passes, refactors — and especially when the user mentions "fable subagents", "fable-gpt", routing models, conserving Fable tokens, the 5-hour limit, or fanning work out. Replaces the retired fable-gpt skill.
---

# Fable + Subagents: one main agent thinks, everything below it executes

Fable is the orchestrator, never the executor. It plans the work, scopes each
task, and spawns subagents only when there's a concrete task to hand off.
Everything mechanical runs on a cheaper or better-suited lane.

## 1 · Orchestrator effort

Fable's own effort is picked per task, not fixed.

- **low** — default lane; most orchestration (scoping, routing, light review) lands here.
- **medium** — used often; still efficient. Real planning, critique, diff review.
- **high** — token cost jumps steeply here; reserve it for tasks that genuinely
  need deep reasoning (architecture, gnarly debugging triage).

Stay low or medium by default. Reaching for high on routine orchestration is
the main way this setup gets expensive.

## 2 · Routing

**Set the subagent's model explicitly the moment you spawn it — never let it
inherit.** A subagent left on its own inherits Fable's reasoning level, which
is the wrong model for almost every execution task.

| Lane | How to spawn | Work |
|------|-------------|------|
| **Sonnet** | `Agent` tool, `model: "sonnet"` | Routine execution: drafts, formatting, high-volume, cheap per call |
| **Opus** | `Agent` tool, `model: "opus"` | Harder execution: debugging, edge cases — only when it earns the cost |
| **GPT 5.6 sol** | `/codex:rescue` → `--model gpt-5.6-sol --effort ultra`, fast service tier | ALL Codex work — design/UI passes AND coding: implementation, refactors, the codebase itself |

Codex lane: **only ever `gpt-5.6-sol` at `--effort ultra`** — no other Codex
model or effort (owner decision 2026-08-18: ultra = max reasoning depth plus automatic task delegation, meaning Codex may spawn its own subagents. Full tier ladder is low/medium/high/xhigh/max/ultra per ~/.codex/models_cache.json). The plugin wrapper's --effort flag may cap below ultra; pass it via `-c model_reasoning_effort=ultra` on codex exec. Speed: always the fast service tier (1.5x speed, burns usage faster — owner decision 2026-08-18): pass `-c service_tier=fast` on codex exec (accepted values are "default"/"fast"; "fast" maps to the priority tier). The global defaults in ~/.codex/config.toml are also ultra + fast now, but keep passing both explicitly. Use `--background` for long tasks; fan
out only across disjoint files. Codex has no conversation context — name the
files, the expected behavior, and how to verify.

**Write access: the codex-companion `task` command sandboxes to read-only by
default — any task that creates or edits files MUST pass `--write`
(maps to workspace-write) ON THE CALL THAT CREATES THE THREAD.** The sandbox
is pinned at thread creation: `--write --resume` on a thread born read-only
is silently ignored and every patch is rejected with "writing is blocked by
read-only sandbox" (observed 2026-08-18, kindle-web build — three wasted
runs). If a thread started read-only, relaunch with `--write --fresh` and a
self-contained prompt. Read-only is right only for review/investigation.

Claude lanes: independent subagents go out in a single message so they run
concurrently; one narrow task per subagent.

## 3 · The shape

A content/campaign task: Fable plans the week and sets angles, then fans out —
Sonnet researches, Sonnet drafts the batch, Opus rewrites the one piece that
can't afford a generic pass, Sonnet schedules. Zero manual work once the brief
is set.

A code task: Fable scopes, GPT 5.6-sol (max) handles both the UI pass and
the implementation. Design and code never run on the Claude lanes when the
Codex lane fits.

## 4 · Cost discipline

Watch which lane is actually running:

- Sonnet: many calls, cheap each — the volume lane.
- Opus: few calls, only when it earns it. **Opus creeping up the bar is the
  tell that Fable is over-routing** — demote work back to Sonnet.
- GPT 5.6-sol: steady design and code passes on the separate Codex budget.

## Review before accepting

Every lane returns confident output whether or not it's correct. Read the
actual diff/draft before accepting: does it match the scope Fable set, and did
it stay inside it? Re-delegate with a sharper prompt rather than fixing inline
— inline fixes are the Fable-token burn this skill exists to avoid.

## When to skip

Quick question, one-line change, or a handoff that takes longer to write than
the work itself: just do it inline. Orchestration has overhead; it pays for
itself only on real tasks.

Summary: Fable thinks at whatever effort the task earns; Sonnet, Opus, and
GPT 5.6-sol (max) do the executing under it.
