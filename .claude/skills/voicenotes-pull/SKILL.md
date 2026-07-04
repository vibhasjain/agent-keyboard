---
name: voicenotes-pull
description: Pull voicenotes for a user-specified time window OR tag, AND surface notes that `list_notes` alone silently drops. Use whenever the user asks "what voicenotes did I make from X to Y", "pull my notes about Z", "get my notes tagged X", or otherwise expects completeness over a time range or a tag.
---

# voicenotes-pull

The voicenotes MCP exposes four tools (`list_notes`, `search_notes`, `get_transcript`, `create_text_note`) but **`list_notes` is buggy: it silently drops notes that exist on the server and fall inside its `date_range`**. In one observed case it returned 5 of 9 notes in the requested window even with `limit: 50` and a tight time range.

If you only call `list_notes` and report the result, you will miss notes the user knows exist. They will push back. Don't get caught.

## The workflow

When the user asks for notes over a time window (or implies completeness with words like "all", "everything", "the bunch", or names a date range) — OR asks for notes **by tag** ("get my notes tagged mobile", "the meeting notes"):

### Step 1 — list pass

Call `mcp__voicenotes__list_notes` once with:
- `date_range: [<startISO>, <endISO>]` covering the requested window. Dates are UTC. If the user said "yesterday evening" and you're in EDT, convert: yesterday evening EDT = 23:00–04:00 UTC across that date boundary.
- `tags: ["<tag>"]` when the request is tag-scoped (lowercase the tag; the API matches case-insensitively).
- `limit: 50` (default is 10, almost never enough).

Collect every UUID into a set. Don't show the user yet.

### Step 2 — search sweeps (the part that catches the dropped notes)

In **one message, parallel tool calls**, run **3–5 `mcp__voicenotes__search_notes` calls** with keyword variations covering what the notes are likely about. Two sources for keywords:

1. **User framing** — what they said the notes were about. "The chat UI changes" → search "chat UI", "modal redesign", "input field". "The shift sheet stuff" → search "shift sheet", "white border peek", "thumbnail filmstrip".
2. **Adjacency** — for every note you already surfaced in Step 1, pick a distinctive phrase from its title or transcript and search it. Notes made in the same session typically reference each other; a search anchored on one usually pulls its siblings.

Three orthogonal sweeps are usually enough. Five if the topic is broad.

**Tag queries get the same treatment.** `list_notes(tags: [...])` has the SAME silent-drop bug as the date-range path — a tag filter is not a shortcut you can trust on its own. After the tag-filtered list pass, still run 3–5 `search_notes` sweeps (keywords drawn from the tag's likely topics + adjacency from the notes already surfaced), then in Step 3 keep only the results whose returned `tags` actually include the requested tag (case-insensitive). That confirms the tag list was complete — or catches a tagged note it dropped.

### Step 3 — merge, filter, sort

- Union all UUIDs from Step 1 + Step 2.
- Drop any whose date is outside the user's requested window (search results aren't date-bounded).
- Sort chronologically (earliest first usually, unless the user is clearly working backwards).
- Count.

### Step 3b — fetch full transcripts (ALWAYS)

The transcripts in `list_notes` / `search_notes` payloads are **truncated previews** (they trail off with `…`). Never present or reason off a preview. For every note you're going to show, call `get_transcript(recording_uuid:)` to pull the complete text first. Fetch them in parallel. This is non-negotiable — we always work from full transcripts, not previews.

### Step 4 — present

Lead with the count: **"Found N notes in that window."** Then a compact table — time, UUID, one-line topic. If there are fewer than 4 notes, show the full transcripts inline (from Step 3b). If more, ask which ones to expand or grab the most relevant 2–3 yourself — still via `get_transcript`, never the preview.

If you find notes via `search_notes` that `list_notes` didn't return, **say so explicitly** ("Two notes (UUIDs X, Y) only surfaced via search — list_notes dropped them.") so the user understands why the count grew.

## Tell-tale signs you have more to find

- Time gaps in the list that don't match the user's description ("I was making notes all evening" but your list shows a 4-hour gap).
- The user names a specific time you don't have a note for ("did you get the 7:46pm?").
- The notes you have reference work that needs follow-up notes you don't see.

When any of these fire, run another `search_notes` pass with fresh keywords before re-answering.

## Tool reference (the MCP's surface)

- `mcp__voicenotes__list_notes` — params: `date_range: [startISO, endISO]`, `tags: string[]`, `limit: int` (1–50, default 10), `cursor: int`. Returns: title, UUID, type, date, transcript or summary.
- `mcp__voicenotes__search_notes` — params: `query: string`. Semantic search. NOT date-bounded; you filter by date yourself.
- `mcp__voicenotes__get_transcript` — params: `recording_uuid`. Full transcript + metadata.
- `mcp__voicenotes__create_text_note` — for writing a note back (rarely useful).

No threading / parent / split API is exposed. If the user asks about threading, tell them straight: the MCP doesn't surface it.

## Date conversion cheat sheet

- The MCP stores and returns dates in UTC.
- User is in America/New_York (EDT in summer, EST in winter). EDT = UTC−4, EST = UTC−5.
- "Yesterday 7:41pm" EDT = `<yesterdayDate>T23:41:00Z`. "This morning 10:42am" EDT = `<todayDate>T14:42:00Z`.
- Confirm timezone if ambiguous; don't assume.
