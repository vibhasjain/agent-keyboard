import { CONTEXT_DEFAULTS, type ContextSettings, type TurnUsage } from "./harness.js";

export function rotationReason(usage: TurnUsage | null, settings: ContextSettings, now = Date.now()): string | null {
  if (!usage) return null;
  const knobs = { ...CONTEXT_DEFAULTS, ...settings };
  if (usage.contextTokens > knobs.maxContextTokens) return "context cap";
  if (now - Date.parse(usage.at) > knobs.idleRotateMinutes * 60_000 &&
      (usage.contextTokens > knobs.idleRotateMinTokens || usage.freshCron)) return "idle";
  return null;
}

/** Quoted transcript data, bounded even when a single assistant turn is huge. */
export function shortHandoff(messages: { role: string; text: string }[]): string {
  const recent = messages.filter(m => (m.role === "user" || m.role === "assistant") && m.text.trim()).slice(-6);
  return recent.length ? `Earlier in this chat (for context)\n${recent.map(m => `${m.role}: ${JSON.stringify(m.text.slice(0, 500))}`).join("\n")}\nEnd of earlier context.\n\n` : "";
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function turnWatchdog(cap = CONTEXT_DEFAULTS.turnMaxContextTokens) {
  let previous = "", count = 0;
  const seen = new Set<string>();
  return (event: { t: string; name?: string; input?: unknown; id?: string; contextTokens?: number }): string | null => {
    if (event.t === "usage" && (event.contextTokens ?? 0) > cap) return `Stopped: context passed ${cap / 1000}k tokens`;
    if (event.t !== "tool") return null;
    if (event.id && seen.has(event.id)) return null;
    if (event.id) seen.add(event.id);
    const key = canonical([event.name, event.input]);
    count = key === previous ? count + 1 : 1;
    previous = key;
    return count >= 20 ? "Stopped: 20 identical tool calls in a row — polling loop" : null;
  };
}
