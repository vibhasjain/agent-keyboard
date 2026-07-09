// Unit-style check of the stream-json parser + accumulation semantics. Feeds
// synthesized stream-json lines (matching the shapes claude.ts emits) through
// parseStreamLine and asserts:
//   - text deltas accumulate (full-replace, "longer wins" with snapshots)
//   - tool_use blocks condense to compact activity lines
//   - assistant snapshot text is captured authoritatively
//   - thinking deltas surface as status detail
//   - the result line is parsed
// Run: `npx tsx src/dev/parse-check.ts` (kept out of the Docker image path).

import assert from "node:assert/strict";
import { parseStreamLine, type LowEvent } from "../claude.js";

// ── synthesize a realistic stream-json transcript (one turn) ──────────────
const delta = (text: string) =>
  JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const thinking = (t: string) =>
  JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: t } } });
const assistantTool = (name: string, input: unknown) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const assistantText = (text: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
const resultLine = (result: string) =>
  JSON.stringify({ type: "result", subtype: "success", result, is_error: false, total_cost_usd: 0.012, duration_ms: 4200 });

const lines = [
  delta("Sure, "),
  delta("updating "),
  delta("the header now."),
  thinking("the hero uses a css var, i'll change --accent"),
  assistantTool("Bash", { command: "git   status   --porcelain" }),
  assistantTool("Edit", { file_path: "/data/checkouts/blog/site/index.html" }),
  assistantTool("Read", { file_path: "site/styles.css" }),
  assistantTool("Grep", { pattern: "--accent" }),
  "   ", // blank/whitespace line — must be ignored
  "{not json", // malformed — must be ignored
  assistantText("Done — changed the header accent to navy and pushed."),
  resultLine("Done — changed the header accent to navy and pushed."),
];

// ── drive them through the parser, replicating the generator's accumulation ──
let streamed = "";
let snapshot = "";
const tools: string[] = [];
const thinkingChunks: string[] = [];
let result: { result?: string; is_error?: boolean; total_cost_usd?: number; duration_ms?: number } | undefined;

const best = () => (streamed.length >= snapshot.length ? streamed : snapshot);

for (const line of lines) {
  const { events, result: r } = parseStreamLine(line);
  if (r) result = r;
  for (const e of events as LowEvent[]) {
    if (e.t === "delta") streamed += e.text;
    else if (e.t === "snapshotText") snapshot += e.text;
    else if (e.t === "tool") tools.push(e.detail);
    else if (e.t === "thinking") thinkingChunks.push(e.text);
  }
}

// ── assertions ────────────────────────────────────────────────────────────
assert.equal(streamed, "Sure, updating the header now.", "text deltas should accumulate");
assert.equal(snapshot, "Done — changed the header accent to navy and pushed.", "snapshot text captured");
// Final: the authoritative snapshot is longer than the streamed intro, so it wins.
assert.equal(best(), "Done — changed the header accent to navy and pushed.", "longer (snapshot) wins");

assert.deepEqual(
  tools,
  ["$ git status --porcelain", "editing index.html", "reading styles.css", "searching for --accent"],
  "tool_use blocks should condense to compact activity lines",
);

assert.equal(thinkingChunks.length, 1, "one thinking delta");
assert.ok(thinkingChunks[0]!.includes("--accent"), "thinking text preserved");

assert.ok(result, "result line parsed");
assert.equal(result!.is_error, false);
assert.equal(result!.result, "Done — changed the header accent to navy and pushed.");
assert.equal(result!.total_cost_usd, 0.012);
assert.equal(result!.duration_ms, 4200);

// Bonus: a whitespace/malformed line yields nothing.
assert.deepEqual(parseStreamLine("   ").events, [], "blank line → no events");
assert.deepEqual(parseStreamLine("{oops").events, [], "malformed line → no events");
assert.equal(parseStreamLine("{oops").result, undefined);

// TodoWrite → a `todos` event carrying the full checklist (content+status,
// blank entries dropped), on top of the one-line "planning" tool status.
{
  const { events } = parseStreamLine(
    assistantTool("TodoWrite", {
      todos: [
        { content: "Read the config", status: "completed", activeForm: "Reading the config" },
        { content: "Wire the frame", status: "in_progress", activeForm: "Wiring the frame" },
        { content: "", status: "pending" },
      ],
    }),
  );
  const todos = events.find((e): e is Extract<LowEvent, { t: "todos" }> => e.t === "todos");
  assert.ok(todos, "TodoWrite yields a todos event");
  assert.deepEqual(
    todos.items,
    [
      { content: "Read the config", status: "completed" },
      { content: "Wire the frame", status: "in_progress" },
    ],
    "todos carry content+status; blank entries are dropped",
  );
  assert.ok(events.some((e) => e.t === "tool" && e.detail === "planning"), "TodoWrite still emits the planning status");
}

// Task (subagent) → a compact "delegating: <description>" activity line.
{
  const { events } = parseStreamLine(assistantTool("Task", { description: "audit the styles", subagent_type: "Explore" }));
  assert.ok(
    events.some((e) => e.t === "tool" && e.detail === "delegating: audit the styles"),
    "Task condenses to a delegating line",
  );
}

// This CLI (2.1.205) uses TaskCreate/TaskUpdate (stateful) and Agent — the names
// the parser must actually match (TodoWrite/Task never fire here).
{
  const created = parseStreamLine(
    assistantTool("TaskCreate", { subject: "Do the thing", description: "…", activeForm: "Doing the thing" }),
  );
  assert.ok(
    created.events.some((e) => e.t === "taskCreate" && e.subject === "Do the thing"),
    "TaskCreate → taskCreate event",
  );
  assert.ok(created.events.some((e) => e.t === "tool" && e.detail === "planning"), "TaskCreate → planning status");

  const updated = parseStreamLine(assistantTool("TaskUpdate", { taskId: "1", status: "in_progress" }));
  assert.ok(
    updated.events.some((e) => e.t === "taskUpdate" && e.taskId === "1" && e.status === "in_progress"),
    "TaskUpdate → taskUpdate event",
  );

  const agent = parseStreamLine(assistantTool("Agent", { description: "audit the styles", subagent_type: "general-purpose" }));
  assert.ok(
    agent.events.some((e) => e.t === "tool" && e.detail === "delegating: audit the styles"),
    "Agent → delegating line",
  );
}

console.log("parse-check OK — accumulation, tool condensation, todos, subagent, thinking, and result parsing all pass.");
