// Natural-language harness controls. The owner steers the agent's own runtime
// ("switch to sonnet", "max effort", "plan mode", "compact your memory") by just
// asking — no slash commands, no buttons. The mechanism: a per-site settings
// JSON on the volume that the AGENT ITSELF reads and edits (its path + schema
// are described to it in the appended system prompt each turn), and that the
// server validates and applies to the next CLI spawn.
//
// The KNOBS table is the generic exposure the owner asked for: one entry per
// knob makes it (a) NL-controllable — the agent edits the file, (b)
// introspectable — current values are injected into every turn's system prompt,
// and (c) validated — bad values degrade to defaults with a warning the agent
// sees and can fix itself. Adding a future knob = adding one entry here.

import { join } from "node:path";
import { DATA_DIR, readDataFile, writeDataFile } from "./checkouts.js";
import { slugifyPage } from "./sites.js";

export type PermissionMode = "bypassPermissions" | "plan" | "acceptEdits" | "default";

export interface CronSettings {
  id: string;
  prompt: string;
  hour: number; // 0-23, default 11
  tz: string; // default America/New_York
  everyHours?: number; // when set, replaces the daily hour slot
  page: string; // default "/"
  fresh: boolean; // default false
  disabled: boolean; // default false
}

/** Per-page override of the site-wide knobs (page-scoped sites). */
export interface PageSettings {
  model?: string;
  effort?: string;
}

export interface HarnessSettings {
  model?: string;
  effort?: string;
  pages?: Record<string, PageSettings>;
  permissionMode?: PermissionMode;
  compactNow?: boolean;
  clearNow?: boolean;
  env?: Record<string, string>;
  cron?: CronSettings | CronSettings[];
}

export interface ResolvedHarness {
  settings: HarnessSettings; // validated values only
  warnings: string[]; // surfaced to the agent via the harness note (self-healing)
  args: string[]; // extra CLI args for this spawn
  env: Record<string, string>; // extra env overlay for this spawn
}

const DEFAULT_MODEL = process.env.CLAUDE_MODEL ?? "opus";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const MODES: PermissionMode[] = ["bypassPermissions", "plan", "acceptEdits", "default"];
const MODEL_ALIASES = ["opus", "sonnet", "haiku"];
const MODEL_RE = /^claude-[a-z0-9.-]+$/i;

interface Knob {
  key: keyof HarnessSettings;
  /** Validated value, or undefined (with a warning pushed) when rejected. */
  validate: (v: unknown, warn: (w: string) => void) => unknown;
  /** CLI args this knob contributes (defaults applied when unset). */
  toArgs?: (v: unknown) => string[];
  /** One line of schema help shown to the agent. */
  describe: string;
}

const KNOBS: Knob[] = [
  {
    key: "model",
    validate: (v, warn) => {
      if (typeof v !== "string" || !v.trim()) return undefined;
      const m = v.trim().toLowerCase();
      if (MODEL_ALIASES.includes(m) || MODEL_RE.test(m)) return m;
      warn(`unknown model ${JSON.stringify(v)} — using ${DEFAULT_MODEL}; valid: ${MODEL_ALIASES.join(" | ")} or a full claude-* id`);
      return undefined;
    },
    toArgs: (v) => ["--model", typeof v === "string" ? v : DEFAULT_MODEL],
    describe: `"model": ${MODEL_ALIASES.map((m) => `"${m}"`).join(" | ")} or a full "claude-*" model id`,
  },
  {
    key: "effort",
    validate: (v, warn) => {
      if (v === undefined || v === null || v === "") return undefined;
      const e = String(v).trim().toLowerCase();
      if ((EFFORTS as readonly string[]).includes(e)) return e;
      warn(`unknown effort ${JSON.stringify(v)} — ignored; valid: ${EFFORTS.join(" | ")}`);
      return undefined;
    },
    // Only emitted when set — the CLI default (model-dependent) applies otherwise.
    toArgs: (v) => (typeof v === "string" ? ["--effort", v] : []),
    describe: `"effort": ${EFFORTS.map((e) => `"${e}"`).join(" | ")} (unset = the model's default)`,
  },
  {
    key: "permissionMode",
    validate: (v, warn) => {
      if (v === undefined || v === null || v === "") return undefined;
      const m = String(v).trim() as PermissionMode;
      if (MODES.includes(m)) return m;
      warn(`unknown permissionMode ${JSON.stringify(v)} — using bypassPermissions; valid: ${MODES.join(" | ")}`);
      return undefined;
    },
    toArgs: (v) => ["--permission-mode", typeof v === "string" ? v : "bypassPermissions"],
    describe: `"permissionMode": ${MODES.map((m) => `"${m}"`).join(" | ")} (default bypassPermissions)`,
  },
  {
    key: "compactNow",
    validate: (v, warn) => {
      if (v === undefined || v === null || v === false) return undefined;
      if (v === true) return true;
      warn(`compactNow must be true or absent, got ${JSON.stringify(v)} — ignored`);
      return undefined;
    },
    describe: `"compactNow": true — the server compacts this conversation's memory right after the current turn, then clears the flag`,
  },
  {
    key: "clearNow",
    validate: (v, warn) => {
      if (v === undefined || v === null || v === false) return undefined;
      if (v === true) return true;
      warn(`clearNow must be true or absent, got ${JSON.stringify(v)} — ignored`);
      return undefined;
    },
    describe: `"clearNow": true — DESTRUCTIVE: right after this turn the server starts a fresh session (wipes the agent's memory of this conversation) AND clears the chat history, then clears the flag. Unlike compact this keeps nothing. Because it can't be undone, confirm with the owner once before you set it`,
  },
];

// The page knob reuses the site-level validators verbatim, so an override can
// never accept a model or effort the site knob would reject.
function knobValidate(key: "model" | "effort", v: unknown, warn: (w: string) => void): unknown {
  return KNOBS.find((k) => k.key === key)!.validate(v, warn);
}

KNOBS.push({
  key: "pages",
  validate: (v, warn) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "object" || Array.isArray(v)) {
      warn(`pages must be an object keyed by page path, got ${JSON.stringify(v)} — ignored`);
      return undefined;
    }
    const out: Record<string, PageSettings> = {};
    for (const [page, raw] of Object.entries(v as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        warn(`pages[${JSON.stringify(page)}] must be an object like {"model": "opus"} — dropped`);
        continue;
      }
      const entry = raw as Record<string, unknown>;
      for (const k of Object.keys(entry)) {
        if (k !== "model" && k !== "effort") warn(`pages[${JSON.stringify(page)}].${k} is not overridable — ignored; valid keys: model, effort`);
      }
      const model = knobValidate("model", entry.model, warn);
      const effort = knobValidate("effort", entry.effort, warn);
      if (model === undefined && effort === undefined) continue;
      // Keyed by slug, so "/jobs", "jobs" and "/jobs/" are the same page.
      out[slugifyPage(page)] = {
        ...(typeof model === "string" ? { model } : {}),
        ...(typeof effort === "string" ? { effort } : {}),
      };
    }
    return Object.keys(out).length ? out : undefined;
  },
  describe: `"pages": {"/jobs": {"model": "opus", "effort": "high"}} — per-page overrides for a page-scoped site: that page's session runs with these instead of the site-wide "model"/"effort" (only those two are overridable; "/" is the site root, and every other page keeps the site values)`,
});

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
KNOBS.push({
  key: "env",
  validate: (v, warn) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "object" || Array.isArray(v)) {
      warn(`env must be an object of string values, got ${JSON.stringify(v)} — ignored`);
      return undefined;
    }
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (ENV_NAME_RE.test(k) && typeof val === "string") out[k] = val;
      else warn(`env.${k} must be a string under a valid variable name — dropped`);
    }
    return out;
  },
  describe: `"env": {"NAME": "value", …} — extra environment variables for your shell, e.g. {"SUPABASE_ACCESS_TOKEN": "sbp_…"} logs the supabase CLI into this site's own Supabase account (the owner pastes the token; never print it back)`,
});

// ponytail: duplicated (not imported) from cron.ts's own per-field checks —
// importing them here would make cron.ts and harness.ts import each other
// (cron.ts already needs loadHarness below). Four one-line predicates aren't
// worth a cycle.
function isValidCronHour(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 23;
}
function isValidCronTz(v: unknown): v is string {
  if (typeof v !== "string" || !v.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v }).format();
    return true;
  } catch {
    return false;
  }
}

const CRON_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function validateCronEntry(
  value: unknown,
  label: string,
  idRequired: boolean,
  warn: (w: string) => void,
): CronSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warn(`${label} must be an object — cron dropped`);
    return undefined;
  }
  const c = value as Record<string, unknown>;
  let id = c.id;
  if (id === undefined && idRequired) {
    warn(`${label}.id is required when cron has multiple entries — cron dropped`);
    return undefined;
  }
  if (id === undefined) id = "cron";
  if (typeof id !== "string" || !CRON_ID_RE.test(id)) {
    warn(`${label}.id must be a lowercase slug — cron dropped`);
    return undefined;
  }
  if (typeof c.prompt !== "string" || !c.prompt.trim()) {
    warn(`${label}.prompt must be a non-empty string — cron dropped`);
    return undefined;
  }
  const hour = c.hour === undefined ? 11 : c.hour;
  if (!isValidCronHour(hour)) {
    warn(`${label}.hour must be an integer 0-23 — cron dropped`);
    return undefined;
  }
  const tz = c.tz === undefined ? "America/New_York" : c.tz;
  if (!isValidCronTz(tz)) {
    warn(`${label}.tz must be a valid time zone name — cron dropped`);
    return undefined;
  }
  let everyHours: number | undefined;
  if (c.everyHours !== undefined) {
    if (typeof c.everyHours !== "number" || !Number.isFinite(c.everyHours) || c.everyHours <= 0) {
      warn(`${label}.everyHours must be a finite number greater than 0 — cron dropped`);
      return undefined;
    }
    everyHours = c.everyHours;
  }
  const page = c.page === undefined ? "/" : c.page;
  if (typeof page !== "string" || !page.startsWith("/")) {
    warn(`${label}.page must be a string starting with "/" — cron dropped`);
    return undefined;
  }
  if (c.fresh !== undefined && typeof c.fresh !== "boolean") {
    warn(`${label}.fresh must be a boolean — cron dropped`);
    return undefined;
  }
  if (c.disabled !== undefined && typeof c.disabled !== "boolean") {
    warn(`${label}.disabled must be a boolean — cron dropped`);
    return undefined;
  }
  const cron: CronSettings = {
    id,
    prompt: c.prompt,
    hour,
    tz,
    page,
    fresh: c.fresh === true,
    disabled: c.disabled === true,
  };
  if (everyHours !== undefined) cron.everyHours = everyHours;
  return cron;
}

KNOBS.push({
  key: "cron",
  validate: (v, warn) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "object") {
      warn(`cron must be an object or an array of objects — dropped`);
      return undefined;
    }
    const values = Array.isArray(v) ? v : [v];
    if (values.length === 0) {
      warn(`cron array must contain at least one entry — cron dropped`);
      return undefined;
    }
    const cron: CronSettings[] = [];
    const ids = new Set<string>();
    for (const [index, value] of values.entries()) {
      const entry = validateCronEntry(value, Array.isArray(v) ? `cron[${index}]` : "cron", values.length > 1, warn);
      if (!entry) return undefined;
      if (ids.has(entry.id)) {
        warn(`cron has duplicate id ${JSON.stringify(entry.id)} — cron dropped`);
        return undefined;
      }
      ids.add(entry.id);
      cron.push(entry);
    }
    return Array.isArray(v) ? cron : cron[0];
  },
  describe: `"cron": {"id"?: "cron", "hour": 0-23, "tz": "America/New_York", "everyHours"?: n, "page": "/jobs", "fresh": true|false, "disabled": true|false, "prompt": "[scheduled] …"} or an array of these entries — use the array form for phases and give each a unique slug "id" (required with multiple entries); the server sends "prompt" at hour:00 in tz (or every everyHours hours); "disabled": true pauses it; "fresh": true starts a new session before each run; changes apply from the next tick (≤5 min)`,
});

function siteRel(siteId: string, file: string): string {
  return join("agent-keyboard", "sites", siteId, file);
}

/** Absolute path of a site's harness settings file (shown to the agent).
 *  MUST derive from the same DATA_DIR the read/write helpers use — a diverging
 *  copy would tell the agent to edit a file the server never reads. */
export function settingsPathFor(siteId: string): string {
  return join(DATA_DIR, siteRel(siteId, "settings.json"));
}

function validateSettings(raw: unknown, warnings: string[]): HarnessSettings {
  const warn = (w: string) => warnings.push(w);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== null && raw !== undefined) warn("settings.json must be a JSON object — ignored");
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const settings: HarnessSettings = {};
  const known = new Set(KNOBS.map((k) => k.key as string));
  for (const k of Object.keys(obj)) {
    if (!known.has(k)) warn(`unknown setting ${JSON.stringify(k)} — ignored; valid keys: ${[...known].join(", ")}`);
  }
  for (const knob of KNOBS) {
    const v = knob.validate(obj[knob.key], warn);
    if (v !== undefined) (settings as Record<string, unknown>)[knob.key] = v;
  }
  return settings;
}

function resolve(settings: HarnessSettings, warnings: string[]): ResolvedHarness {
  const args: string[] = [];
  for (const knob of KNOBS) {
    if (knob.toArgs) args.push(...knob.toArgs(settings[knob.key]));
  }
  return { settings, warnings, args, env: settings.env ?? {} };
}

/** The no-settings-file harness: exactly the historical hardcoded CLI args. */
export function defaultHarness(): ResolvedHarness {
  return resolve({}, []);
}

/** One-shot fallback when the CLI rejects self-persisted args (which would
 *  otherwise wedge every future turn): drop model/effort — the only knobs whose
 *  validation can pass a value the runtime still rejects (claude-* ids) — but
 *  KEEP permissionMode. Flipping a plan-mode site to bypassPermissions because
 *  its model id was bad would silently drop the owner's safety intent. */
export function fallbackHarness(prev: HarnessSettings): ResolvedHarness {
  return resolve(prev.permissionMode ? { permissionMode: prev.permissionMode } : {}, []);
}

/** Fold a page's override onto the site-wide settings. The result is what the
 *  turn actually runs with, so the banner and the harness note both show the
 *  effective model rather than the site default the page isn't using. */
function forPage(settings: HarnessSettings, pageSlug: string): HarnessSettings {
  const override = settings.pages?.[pageSlug];
  return override ? { ...settings, ...override } : settings;
}

/** Load + validate a site's harness settings. No file → today's exact defaults.
 *  `pageSlug` (from pageSlugFor) selects a per-page override when one is set. */
export async function loadHarness(siteId: string, pageSlug = ""): Promise<ResolvedHarness> {
  const warnings: string[] = [];
  const raw = await readDataFile(siteRel(siteId, "settings.json"));
  if (!raw) return resolve({}, warnings);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnings.push("your settings file is invalid JSON and was ignored — rewrite it as a valid JSON object");
    return resolve({}, warnings);
  }
  return resolve(forPage(validateSettings(parsed, warnings), pageSlug), warnings);
}

/** Merge a validated patch into the settings file (used by reply directives). */
export async function saveSettings(siteId: string, patch: Partial<HarnessSettings>): Promise<void> {
  const raw = await readDataFile(siteRel(siteId, "settings.json"));
  let current: Record<string, unknown> = {};
  try {
    if (raw) current = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* replace the broken file */
  }
  const merged = { ...current, ...patch };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete (merged as Record<string, unknown>)[k];
  await writeDataFile(siteRel(siteId, "settings.json"), JSON.stringify(merged, null, 2) + "\n");
}

export async function clearCompactFlag(siteId: string): Promise<void> {
  await saveSettings(siteId, { compactNow: undefined } as Partial<HarnessSettings>);
}

// ─── context-usage introspection ─────────────────────────────────────────────
// Approximate: stream-json usage rows have known quirks (placeholder
// input_tokens on some entries), so we take the max plausible total per turn and
// present it as "~N% used". Good enough for "how much context is left?".

export interface TurnUsage {
  contextTokens: number;
  contextPct: number;
  at: string;
}

const parsedWindow = Number(process.env.CONTEXT_WINDOW_TOKENS ?? 200_000);
export const CONTEXT_WINDOW_TOKENS =
  Number.isFinite(parsedWindow) && parsedWindow > 0 ? parsedWindow : 200_000;

export async function writeLastUsage(siteId: string, u: TurnUsage): Promise<void> {
  await writeDataFile(siteRel(siteId, "last-usage.json"), JSON.stringify(u) + "\n");
}

export async function readLastUsage(siteId: string): Promise<TurnUsage | null> {
  const raw = await readDataFile(siteRel(siteId, "last-usage.json"));
  if (!raw) return null;
  try {
    const u = JSON.parse(raw) as TurnUsage;
    return typeof u.contextTokens === "number" ? u : null;
  } catch {
    return null;
  }
}

// ─── the harness note (appended to the system prompt every turn) ─────────────

function cronEntries(cron: CronSettings | CronSettings[]): CronSettings[] {
  return Array.isArray(cron) ? cron : [cron];
}

function cronTzLabel(tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortGeneric" })
    .formatToParts(new Date())
    .find((part) => part.type === "timeZoneName")?.value ?? tz;
}

function describeCron(cron: CronSettings): string {
  const schedule = cron.everyHours === undefined
    ? `@${String(cron.hour).padStart(2, "0")} ${cronTzLabel(cron.tz)}`
    : ` every ${cron.everyHours}h`;
  return `${cron.id}${schedule}${cron.fresh ? " fresh" : ""}${cron.disabled ? " paused" : ""}`;
}

export function harnessNote(siteId: string, h: ResolvedHarness, usage: TurnUsage | null): string {
  const s = h.settings;
  const model = s.model ?? DEFAULT_MODEL;
  const effort = s.effort ?? "default";
  const mode = s.permissionMode ?? "bypassPermissions";
  const cron = s.cron
    ? `, cron ${cronEntries(s.cron).map(describeCron).join(" · ")}`
    : "";
  const lines = [
    `Harness: model ${model}, effort ${effort}, permissions ${mode}${cron}${s.env && Object.keys(s.env).length ? `, env ${Object.keys(s.env).join(",")}` : ""}.` +
      (cron ? " You OWN this schedule: to add, move, pause or remove a phase, edit the \"cron\" array in your settings.json (path above) — never say you can only change the runbook." : "") +
      (usage
        ? ` Context window: ~${usage.contextPct}% used as of the last turn (~${usage.contextTokens.toLocaleString("en-US")} of ${CONTEXT_WINDOW_TOKENS.toLocaleString("en-US")} tokens, approximate).`
        : ""),
    `You control these settings yourself: edit the JSON file at ${settingsPathFor(siteId)} — keys: ${KNOBS.map((k) => k.describe).join("; ")}. Changes apply from the NEXT turn. When asked about your model, settings, or context usage, answer from the values above; when asked to change one, edit that file and confirm.`,
  ];
  if (mode === "plan" || mode === "default") {
    lines.push(
      `You are in ${mode} mode and may not be able to edit files. To change a setting anyway, end your reply with a line of the exact form [[settings: {"permissionMode":"bypassPermissions"}]] — the server applies it and strips the line from your reply.`,
    );
  }
  if (h.warnings.length) {
    lines.push(`Settings warnings (fix your settings file): ${h.warnings.join(" · ")}`);
  }
  return lines.join(" ");
}

// ─── reply directives ────────────────────────────────────────────────────────
// The ONLY purpose is the plan-mode escape hatch: an agent in plan mode cannot
// edit its own settings file to leave plan mode. A trailing
// [[settings: {...}]] line in the reply is validated through the same KNOBS
// table, applied server-side, and stripped from the visible reply.

// Greedy capture anchored to end-of-reply so JSON containing `]` (arrays,
// bracket-bearing strings) still parses.
const DIRECTIVE_RE = /\n?\s*\[\[settings:\s*(\{[\s\S]*\})\s*\]\]\s*$/;

export function extractReplyDirectives(reply: string): {
  patch: Partial<HarnessSettings> | null;
  cleaned: string;
} {
  const m = reply.match(DIRECTIVE_RE);
  if (!m) return { patch: null, cleaned: reply };
  try {
    const warnings: string[] = [];
    const patch = validateSettings(JSON.parse(m[1] ?? "{}"), warnings);
    // Strip ONLY when something valid is applied — an invalid directive stays
    // visible in the reply so the failure is observable, not silently eaten.
    if (!Object.keys(patch).length) return { patch: null, cleaned: reply };
    return { patch, cleaned: reply.slice(0, m.index ?? reply.length).trimEnd() };
  } catch {
    return { patch: null, cleaned: reply };
  }
}
