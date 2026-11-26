// Moving a site's agent context to another instance (Notes spec 19, gaps in 20): the old
// instance exports one site's notes, memory, settings (env values only when the owner opts in,
// sealed to a one-time key the importer sends), its runtime-installed skills, optionally the
// agent's other .tmp/ working files, its domain, origins and sandbox preview, and a summary of the
// recent conversation as a tar.gz,
// gated by a single-use token its owner approves; the new instance pulls that
// bundle and merges it in without overwriting anything.

import { createCipheriv, createDecipheriv, createPublicKey, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes, constants } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { Response } from "express";
import { CLAUDE_HOME, conversationIdFor } from "./claude.js";
import { checkoutPath, ensureCheckout, git } from "./checkouts.js";
import { readConversation } from "./conversation.js";
import { saveSettings, settingsPathFor } from "./harness.js";
import { NOTES_REL, validNoteImage, validNoteName, validOrder, type NoteMeta, type NoteOrder } from "./notes.js";
import { createSandbox, getSandbox, listSandboxes } from "./sandboxes.js";
import { SKILLS_SRC } from "./skills.js";
import { addTeamNote } from "./team.js";
import { SITES, type Site } from "./sites.js";

const execFileP = promisify(execFile);
const MAX_BYTES = 200 * 1024 * 1024;
const SETTINGS_KEYS = ["model", "effort", "maxBudgetUsd", "maxContextTokens", "idleRotateMinutes", "idleRotateMinTokens", "turnMaxContextTokens", "cron", "pages"];
const TOP = new Set(["notes", "memory", "skills", "settings.json", "summary.md", "manifest.json", "sandboxes", "notes-archive", "env.enc", "work"]);
const WORK_MAX = 50 * 1024 * 1024; // the agent's .tmp/ working files, opt-in
const WORK_SKIP = new Set(["notes", "notes-archive", "uploads", "outputs"]); // top-level .tmp/ dirs that move another way, or not at all

/** What the owner approved beyond notes, memory and settings. */
export interface ExportGrant {
  skills: boolean;
  keys: boolean;
  files: boolean;
}

export const memoryDir = (siteId: string) =>
  join(CLAUDE_HOME, ".claude", "projects", checkoutPath(siteId).replace(/[^a-zA-Z0-9]/g, "-"), "memory");

// ─── export tokens: single use, 10 minutes, one site ─────────────────────────
const tokens = new Map<string, { siteId: string; exp: number; grant: ExportGrant }>();

export function mintExportToken(siteId: string, grant: ExportGrant): string {
  for (const [t, v] of tokens) if (v.exp < Date.now()) tokens.delete(t);
  const token = randomBytes(24).toString("base64url");
  tokens.set(token, { siteId, exp: Date.now() + 10 * 60_000, grant });
  return token;
}

/** Single use: returns what the bundle may carry, or null when the token isn't valid for this site. */
export function redeemExportToken(token: string, siteId: string): ExportGrant | null {
  const t = tokens.get(token);
  if (!t) return null;
  tokens.delete(token);
  return t.siteId === siteId && t.exp > Date.now() ? t.grant : null;
}

// ─── env values: sealed to the importer's one-time RSA key (AES-256-GCM, key wrapped with RSA-OAEP) ──
function seal(plain: string, publicKey: string): string {
  const key = randomBytes(32), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  const wrapped = publicEncrypt({ key: createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" }), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  return JSON.stringify({ key: wrapped.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") });
}

function unseal(box: string, privateKey: string): string {
  const b = JSON.parse(box) as Record<string, string>;
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(b.key!, "base64"));
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(b.iv!, "base64"));
  d.setAuthTag(Buffer.from(b.tag!, "base64"));
  return Buffer.concat([d.update(Buffer.from(b.data!, "base64")), d.final()]).toString("utf8");
}

/** Copy the agent's .tmp/ working files minus notes, uploads, outputs, links and nested git checkouts, up to WORK_MAX. */
async function copyWork(from: string, to: string): Promise<void> {
  let total = 0;
  await cp(from, to, {
    recursive: true,
    filter: async (p) => {
      if (p === from) return true;
      const st = await lstat(p);
      const rel = p.slice(from.length + 1);
      if (st.isSymbolicLink() || WORK_SKIP.has(rel) || /(^|\/)(node_modules|\.git)$/.test(rel)) return false;
      if (st.isDirectory()) return !existsSync(join(p, ".git"));
      if (!st.isFile() || total + st.size > WORK_MAX) return false;
      total += st.size;
      return true;
    },
  });
}

/** The bar's origins on the old instance: its domain (+www) and EXTRA_ORIGINS, which are instance-wide,
 *  so only the ones on this site's domain unless it's the instance's only site. */
function originsOf(site: Site): string[] {
  const extra = (process.env.EXTRA_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  const own = SITES.length <= 1 ? extra : extra.filter((o) => { try { const h = new URL(o).hostname; return h === site.domain || h.endsWith(`.${site.domain}`); } catch { return false; } });
  return [...new Set([`https://${site.domain}`, `https://www.${site.domain}`, ...own])];
}

// ─── export ──────────────────────────────────────────────────────────────────
/** Stream one site's bundle. Skills are instance-wide, so only owners of non-guest sites get them. */
export async function streamExport(site: Site, grant: ExportGrant, publicKey: string, res: Response): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ak-export-"));
  try {
    const notes = join(checkoutPath(site.id), NOTES_REL);
    if (existsSync(notes)) await cp(notes, join(dir, "notes"), { recursive: true, filter: (p) => !/\/(\.base|\.merge-[^/]*)$/.test(p) });
    if (existsSync(memoryDir(site.id))) await cp(memoryDir(site.id), join(dir, "memory"), { recursive: true });
    const archive = join(checkoutPath(site.id), ".tmp", "notes-archive");
    if (existsSync(archive)) await cp(archive, join(dir, "notes-archive"), { recursive: true });

    // Open sandboxes: their branch is in the repo already; their notes (with the .base snapshot), memory and recent chat.
    for (const { name, createdBy } of await listSandboxes(site.id)) {
      const sb = getSandbox(`${site.id}--sb-${name}`)!, to = join(dir, "sandboxes", name);
      await mkdir(to, { recursive: true });
      const sbNotes = join(checkoutPath(sb.id), NOTES_REL);
      if (existsSync(sbNotes)) await cp(sbNotes, join(to, "notes"), { recursive: true, filter: (p) => !/\/\.merge-[^/]*$/.test(p) });
      if (existsSync(memoryDir(sb.id))) await cp(memoryDir(sb.id), join(to, "memory"), { recursive: true });
      await writeFile(join(to, "summary.md"), await summaryOf(sb.id));
      await writeFile(join(to, "meta.json"), JSON.stringify({ branch: sb.branch, createdBy, createdAt: sb.createdAt, checkout: checkoutPath(sb.id), memoryDir: memoryDir(sb.id) }));
    }

    const settings = await readFile(settingsPathFor(site.id), "utf8").then(JSON.parse).catch(() => ({}));
    const out: Record<string, unknown> = Object.fromEntries(SETTINGS_KEYS.filter((k) => settings[k] !== undefined).map((k) => [k, settings[k]]));
    out.envNames = Object.keys(settings.env ?? {});
    await writeFile(join(dir, "settings.json"), JSON.stringify(out, null, 2));
    // The values only with the owner's opt-in, and only sealed to the importer's key: never plain in the tarball.
    if (grant.keys && publicKey && Object.keys(settings.env ?? {}).length) await writeFile(join(dir, "env.enc"), seal(JSON.stringify(settings.env), publicKey));

    const tmp = join(checkoutPath(site.id), ".tmp");
    if (grant.files && existsSync(tmp)) await copyWork(tmp, join(dir, "work"));

    if (grant.skills) {
      const bundled = new Set(await readdir(SKILLS_SRC).catch(() => [] as string[]));
      const src = join(CLAUDE_HOME, ".claude", "skills");
      for (const name of await readdir(src).catch(() => [] as string[]))
        if (!bundled.has(name) && !name.startsWith(".")) await cp(join(src, name), join(dir, "skills", name), { recursive: true, dereference: true });
    }

    await writeFile(join(dir, "summary.md"), await summaryOf(site.id));
    const preview = site.sandbox?.preview?.replace(/\{domain\}/g, site.domain);
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ siteId: site.id, checkout: checkoutPath(site.id), memoryDir: memoryDir(site.id), domain: site.domain, origins: originsOf(site), sandboxPreview: preview, exportedAt: new Date().toISOString() }));

    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${site.id}-export.tar.gz"`);
    const tar = spawn("tar", ["-czf", "-", "-C", dir, "."], { stdio: ["ignore", "pipe", "inherit"] });
    tar.stdout.pipe(res);
    await new Promise((resolve) => tar.on("close", resolve));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The last ~20 exchanges as a short markdown list (no model call). */
async function summaryOf(siteId: string): Promise<string> {
  const { messages } = await readConversation(siteId, { limit: 40 }).catch(() => ({ messages: [] }));
  const summary = messages
    .filter((m) => m.text?.trim())
    .map((m) => `- **${m.role === "user" ? (m.sender ?? "user") : "agent"}** (${m.ts?.slice(0, 10) ?? ""}): ${m.text.replace(/\s+/g, " ").trim().slice(0, 400)}`)
    .join("\n");
  return `# Recent conversation\n\n${summary || "(none)"}\n`;
}

// ─── import ──────────────────────────────────────────────────────────────────
export interface ImportResult {
  notes: number;
  memories: number;
  skills: string[];
  settings: string[];
  envNames: string[]; // env vars the owner still has to paste (their values didn't come)
  env: string[]; // env vars whose values came along
  files: number; // working files added under .tmp/
  domain?: string; // the old site's domain, origins and sandbox preview pattern, for the control plane to offer
  origins: string[];
  sandboxPreview?: string;
  notesOnly: boolean;
  sandboxes: string[];
}

/** Pull `site`'s bundle from `origin` (with an export token, or a user's session `bearer` for notes only) into `into`. */
export async function importFrom(into: Site, origin: string, site: string, auth: { token?: string; bearer?: string }): Promise<ImportResult> {
  const u = new URL(origin); // the old server's base URL (an instance may sit under a path, e.g. /ak)
  if (!/^https?:$/.test(u.protocol)) throw new Error("origin must be http(s)");
  const base = `${u.origin}${u.pathname.replace(/\/$/, "")}`;
  const dir = await mkdtemp(join(tmpdir(), "ak-import-"));
  try {
    const notesOnly = !auth.token;
    // A one-time key the old instance seals env values to; it never leaves this process.
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072, publicKeyEncoding: { type: "spki", format: "der" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    if (auth.token) {
      const r = await fetch(`${base}/sites/${encodeURIComponent(site)}/export`, { headers: { "x-ak-export": auth.token, "x-ak-export-key": publicKey.toString("base64") } });
      if (!r.ok || !r.body) throw Object.assign(new Error(`export failed: ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`), { status: r.status });
      await download(r.body, join(dir, "bundle.tgz"));
      await unpack(join(dir, "bundle.tgz"), join(dir, "x"));
    } else {
      await pullNotes(base, site, auth.bearer ?? "", join(dir, "x", "notes"));
    }
    const x = join(dir, "x");
    const live = await ensureCheckout(into); // a missing checkout is cloned fresh, which would wipe anything written first
    const result: ImportResult = { notes: 0, memories: 0, skills: [], settings: [], envNames: [], env: [], files: 0, origins: [], notesOnly, sandboxes: [] };
    result.notes = await mergeNotesDir(join(x, "notes"), join(checkoutPath(into.id), NOTES_REL));

    const manifest = await readFile(join(x, "manifest.json"), "utf8").then(JSON.parse).catch(() => ({}));
    const mem = memoryDir(into.id);
    await mkdir(mem, { recursive: true });
    const rewrite = (s: string) =>
      [[manifest.memoryDir, mem], [manifest.checkout, checkoutPath(into.id)]].reduce(
        (acc, [from, to]) => (typeof from === "string" && from.startsWith("/") ? acc.split(from).join(to) : acc),
        s,
      );
    let index: string[] = [];
    const moved: [string, string][] = [];
    for (const f of await readdir(join(x, "memory")).catch(() => [] as string[])) {
      if (!f.endsWith(".md")) continue;
      const text = rewrite(await readFile(join(x, "memory", f), "utf8"));
      if (f === "MEMORY.md") {
        index.push(...text.split("\n").filter((l) => l.startsWith("- ")));
        continue;
      }
      const name = await freeName(mem, f.slice(0, -3), ".md", text);
      if (name === null) continue;
      if (name !== f.slice(0, -3)) moved.push([`(${f})`, `(${name}.md)`]);
      await writeFile(join(mem, `${name}.md`), text);
      result.memories++;
    }

    index = index.map((l) => moved.reduce((acc, [a, b]) => acc.replace(a, b), l));

    const settings = await readFile(join(x, "settings.json"), "utf8").then(JSON.parse).catch(() => ({}));
    result.envNames = Array.isArray(settings.envNames) ? settings.envNames.filter((n: unknown) => typeof n === "string") : [];
    const current = await readFile(settingsPathFor(into.id), "utf8").then(JSON.parse).catch(() => ({}));
    const patch: Record<string, unknown> = Object.fromEntries(SETTINGS_KEYS.filter((k) => settings[k] !== undefined && current[k] === undefined).map((k) => [k, settings[k]]));
    result.settings = Object.keys(patch);
    const sealed = await readFile(join(x, "env.enc"), "utf8").catch(() => "");
    if (sealed) {
      const env = JSON.parse(unseal(sealed, privateKey)) as Record<string, unknown>;
      const have = (current.env ?? {}) as Record<string, string>;
      const add = Object.fromEntries(Object.entries(env).filter(([k, v]) => typeof v === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && have[k] === undefined));
      result.env = Object.keys(add);
      if (result.env.length) patch.env = { ...add, ...have }; // keys already here win
    }
    result.envNames = result.envNames.filter((n) => !result.env.includes(n) && !(n in (current.env ?? {})));
    if (Object.keys(patch).length) await saveSettings(into.id, patch);

    result.domain = typeof manifest.domain === "string" ? manifest.domain : undefined;
    result.origins = Array.isArray(manifest.origins) ? manifest.origins.filter((o: unknown) => typeof o === "string" && /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o)) : [];
    result.sandboxPreview = typeof manifest.sandboxPreview === "string" && /^https:\/\/\S*\{branch\}/.test(manifest.sandboxPreview) ? manifest.sandboxPreview : undefined;

    // The agent's working files: added under .tmp/, never overwriting what's there.
    if (existsSync(join(x, "work"))) {
      const tmp = join(checkoutPath(into.id), ".tmp");
      const files = async () => (await readdir(tmp, { recursive: true, withFileTypes: true }).catch(() => [])).filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name));
      const before = new Set(await files());
      await cp(join(x, "work"), tmp, { recursive: true, force: false, errorOnExist: false });
      result.files = (await files()).filter((f) => !before.has(f)).length;
    }

    const skills = join(CLAUDE_HOME, ".claude", "skills");
    for (const name of await readdir(join(x, "skills")).catch(() => [] as string[])) {
      if (existsSync(join(skills, name))) continue;
      await cp(join(x, "skills", name), join(skills, name), { recursive: true });
      // Old absolute paths (the checkout, the memory dir) inside the skill point here now.
      for (const f of await readdir(join(skills, name), { recursive: true })) {
        const p = join(skills, name, f);
        const st = await lstat(p);
        if (!st.isFile() || st.size > 1024 * 1024) continue;
        const buf = await readFile(p);
        if (buf.includes(0)) continue; // binary
        const text = buf.toString("utf8"), next = rewrite(text);
        if (next !== text) await writeFile(p, next);
      }
      result.skills.push(name);
    }

    const host = new URL(base).host;
    // Archived sandbox notes, one folder per sandbox; a name already here keeps what's there.
    const archive = join(checkoutPath(into.id), ".tmp", "notes-archive");
    for (const name of await readdir(join(x, "notes-archive")).catch(() => [] as string[]))
      if (!existsSync(join(archive, name))) await cp(join(x, "notes-archive", name), join(archive, name), { recursive: true });
    // Open sandboxes: re-register each on its existing branch (still in the repo) with its own notes, memory and recent chat.
    for (const name of into.sandbox ? await readdir(join(x, "sandboxes")).catch(() => [] as string[]) : []) {
      const from = join(x, "sandboxes", name);
      const meta = await readFile(join(from, "meta.json"), "utf8").then(JSON.parse).catch(() => null);
      if (typeof meta?.branch !== "string" || !/^ak\/[\w-]+$/.test(meta.branch)) continue;
      if (!(await git(live, ["ls-remote", "--heads", "origin", meta.branch]).catch(() => ""))) continue; // the branch is gone
      const sb = await createSandbox(into, name, { branch: meta.branch, createdBy: typeof meta.createdBy === "string" ? meta.createdBy : undefined });
      // Its preview is how you get into it, so make this host build one now with an empty commit on its branch.
      await git(checkoutPath(sb.id), ["commit", "--allow-empty", "-m", "Build this sandbox's preview on its new host"])
        .then(() => git(checkoutPath(sb.id), ["push", "origin", `HEAD:${meta.branch}`]))
        .catch((e) => console.error(`agent-keyboard: preview build for ${sb.id}: ${e}`));
      const notes = join(checkoutPath(sb.id), NOTES_REL);
      if (existsSync(join(from, "notes"))) {
        await rm(notes, { recursive: true, force: true });
        await cp(join(from, "notes"), notes, { recursive: true });
      }
      const sbMem = memoryDir(sb.id);
      await mkdir(sbMem, { recursive: true });
      const swap = (t: string) =>
        [[meta.memoryDir, sbMem], [meta.checkout, checkoutPath(sb.id)]].reduce((acc, [a, b]) => (typeof a === "string" && a.startsWith("/") ? acc.split(a).join(b) : acc), t);
      for (const f of await readdir(join(from, "memory")).catch(() => [] as string[]))
        if (f.endsWith(".md")) await writeFile(join(sbMem, f), swap(await readFile(join(from, "memory", f), "utf8")));
      const sbSummary = await readFile(join(from, "summary.md"), "utf8").catch(() => "");
      await writeFile(
        join(sbMem, "previous-instance.md"),
        `---\nname: previous-instance\ndescription: This sandbox moved here from ${host} on ${new Date().toISOString().slice(0, 10)}; its recent conversation there\nmetadata:\n  type: project\n---\n\n` +
          `This sandbox (branch \`${meta.branch}\`) moved here from ${base} with its notes and memory.\n\n${sbSummary.replace(/^# Recent conversation/, "## Recent conversation there")}`,
      );
      const sbIdx = join(sbMem, "MEMORY.md");
      await writeFile(sbIdx, `${(await readFile(sbIdx, "utf8").catch(() => "# Memory index\n")).trimEnd()}\n- [Previous instance](previous-instance.md) — moved from ${host}; the recent conversation there\n`);
      result.sandboxes.push(sb.id.split("--sb-")[1]!);
    }

    const summary = await readFile(join(x, "summary.md"), "utf8").catch(() => "");
    await writeFile(
      join(mem, "previous-instance.md"),
      `---\nname: previous-instance\ndescription: This site moved here from ${host} on ${new Date().toISOString().slice(0, 10)}; what came along and the recent conversation there\nmetadata:\n  type: project\n---\n\n` +
        `This site (\`${site}\` on ${base}) moved to this instance on ${new Date().toISOString().slice(0, 10)}. ` +
        `Brought over: ${result.notes} notes, ${result.memories} memories, settings (${result.settings.join(", ") || "none"}), env values (${result.env.join(", ") || "none"}), ${result.files} working files under .tmp/, skills (${result.skills.join(", ") || "none"}), sandboxes (${result.sandboxes.join(", ") || "none"}).` +
        (result.origins.length ? ` The bar was allowed on ${result.origins.join(", ")} there.` : "") +
        (result.envNames.length ? ` The old site had env vars the owner must paste again: ${result.envNames.join(", ")}.` : "") +
        `\n\n${summary.replace(/^# Recent conversation/, "## Recent conversation there")}`,
    );
    index.push(`- [Previous instance](previous-instance.md) — moved from ${host}; what came along and the recent conversation`);
    const idx = join(mem, "MEMORY.md");
    const had = await readFile(idx, "utf8").catch(() => "# Memory index\n");
    const add = index.filter((l) => !had.includes(l));
    if (add.length) await writeFile(idx, `${had.trimEnd()}\n${add.join("\n")}\n`);

    await addTeamNote(into.id, await conversationIdFor(into.id, ""), {
      id: randomBytes(8).toString("hex"),
      role: "assistant",
      text:
        `Moved from ${host}. ` +
        (notesOnly ? `Notes came along (${result.notes}); memory and settings need ${host} updated first.` : `Notes, memory and settings came along: ${result.notes} notes, ${result.memories} memories${result.env.length ? `, keys (${result.env.join(", ")})` : ""}${result.files ? `, ${result.files} working files` : ""}${result.skills.length ? `, ${result.skills.length} skills` : ""}${result.sandboxes.length ? `, ${result.sandboxes.length} sandboxes (${result.sandboxes.join(", ")})` : ""}.`) +
        (result.envNames.length ? ` Paste these env values again: ${result.envNames.join(", ")}.` : ""),
      tools: [],
      ts: new Date().toISOString(),
    });
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function download(body: ReadableStream<Uint8Array>, file: string): Promise<void> {
  const out = createWriteStream(file);
  let n = 0;
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    if ((n += chunk.length) > MAX_BYTES) {
      out.destroy();
      throw new Error("bundle is over 200 MB");
    }
    if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
  }
  await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
}

/** Only regular files and dirs, relative paths with no `..`, under the known top-level names, 200 MB unpacked. */
async function unpack(file: string, to: string): Promise<void> {
  const { stdout } = await execFileP("tar", ["-tzvf", file], { maxBuffer: 64 * 1024 * 1024 });
  const { stdout: names } = await execFileP("tar", ["-tzf", file], { maxBuffer: 64 * 1024 * 1024 });
  let total = 0;
  for (const line of stdout.split("\n").filter(Boolean)) {
    if (!"-d".includes(line[0]!)) throw new Error("bundle has a link or special file");
    total += Number(line.trim().split(/\s+/)[2]) || 0;
  }
  if (total > MAX_BYTES) throw new Error("bundle unpacks to over 200 MB");
  for (const raw of names.split("\n").filter(Boolean)) {
    const p = raw.replace(/^\.\//, "").replace(/\/$/, "");
    if (p === "." || p === "") continue;
    if (p.startsWith("/") || p.split("/").includes("..") || !TOP.has(p.split("/")[0]!)) throw new Error(`bundle has an unexpected path: ${p.slice(0, 80)}`);
  }
  await mkdir(to, { recursive: true });
  await execFileP("tar", ["-xzf", file, "-C", to, "--no-same-owner", "--no-same-permissions"]);
}

/** A name for `base` in `dir` that doesn't clobber: itself, else "base (imported)"; null when an identical copy is already there. */
async function freeName(dir: string, base: string, ext: string, content: string | Buffer): Promise<string | null> {
  for (const name of [base, `${base} (imported)`]) {
    const have = await readFile(join(dir, `${name}${ext}`)).catch(() => null);
    if (!have) return name;
    if (have.equals(Buffer.from(content))) return null;
  }
  return null; // both taken: keep what's there
}

/** Notes in, never clobbering: a taken name comes in as "name (imported)"; folders, blame and images follow. */
async function mergeNotesDir(src: string, dst: string): Promise<number> {
  await mkdir(dst, { recursive: true });
  const json = (p: string, d: unknown) => readFile(p, "utf8").then(JSON.parse).catch(() => d);
  const renamed = new Map<string, string>();
  for (const f of await readdir(src).catch(() => [] as string[])) {
    const n = f.slice(0, -3);
    if (!f.endsWith(".md") || !validNoteName(n)) continue;
    const content = await readFile(join(src, f), "utf8");
    const name = await freeName(dst, n, ".md", content);
    if (name === null || !validNoteName(name)) continue;
    await writeFile(join(dst, `${name}.md`), content);
    renamed.set(n, name);
  }
  const images = (await readdir(join(src, "images")).catch(() => [] as string[])).filter(validNoteImage);
  if (images.length) await mkdir(join(dst, "images"), { recursive: true });
  for (const f of images) if (!existsSync(join(dst, "images", f))) await cp(join(src, "images", f), join(dst, "images", f));

  const srcOrder = await json(join(src, ".order.json"), []);
  const order = (await json(join(dst, ".order.json"), [])) as NoteOrder;
  const live = validOrder(order) ? order : [];
  for (const i of validOrder(srcOrder) ? srcOrder : []) {
    if (typeof i === "string") {
      if (renamed.has(i)) live.push(renamed.get(i)!);
      continue;
    }
    const notes = i.notes.filter((n) => renamed.has(n)).map((n) => renamed.get(n)!);
    const f = live.find((x) => typeof x !== "string" && x.folder === i.folder) as { notes: string[] } | undefined;
    if (f) f.notes.push(...notes);
    else live.push({ folder: i.folder, notes });
  }
  await writeFile(join(dst, ".order.json"), JSON.stringify(live));

  const srcMeta = (await json(join(src, ".meta.json"), {})) as Record<string, NoteMeta>;
  const meta = (await json(join(dst, ".meta.json"), {})) as Record<string, NoteMeta>;
  for (const [from, to] of renamed) if (srcMeta[from]) meta[to] = srcMeta[from];
  await writeFile(join(dst, ".meta.json"), JSON.stringify(meta));
  return renamed.size;
}

/** Older instances without /export: notes through the bar's own endpoints, with the user's session there. */
async function pullNotes(base: string, site: string, bearer: string, to: string): Promise<void> {
  const get = async (path: string) => {
    const r = await fetch(`${base}/sites/${encodeURIComponent(site)}/${path}`, { headers: { Authorization: `Bearer ${bearer}` } });
    if (!r.ok) throw Object.assign(new Error(`${path}: ${r.status}`), { status: r.status });
    return r;
  };
  await mkdir(join(to, "images"), { recursive: true });
  const order = await (await get("notes-order")).json();
  await writeFile(join(to, ".order.json"), JSON.stringify(order));
  const names = ((validOrder(order) ? order : []) as NoteOrder).flatMap((i) => (typeof i === "string" ? [i] : i.notes)).filter(validNoteName);
  for (const n of names) {
    const { content } = (await (await get(`notes/${encodeURIComponent(n)}`)).json()) as { content: string };
    await writeFile(join(to, `${n}.md`), content);
    for (const [, f] of content.matchAll(/images\/([0-9a-f-]{36}\.(?:png|jpg|gif|webp))/g)) {
      if (existsSync(join(to, "images", f!))) continue;
      const r = await get(`notes-images/${f}`).catch(() => null);
      if (r) await writeFile(join(to, "images", f!), Buffer.from(await r.arrayBuffer()));
    }
  }
}
