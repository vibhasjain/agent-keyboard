// Seed the repo-shipped skills (server/skills/*, baked into the image at
// /app/skills) into ~/.claude/skills on the volume at boot. force:true so a
// deploy updates repo skills in place; other directories are never touched, so
// skills the agent installs itself persist across deploys.

import { copyFile, cp, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLAUDE_HOME } from "./claude.js";

const SKILLS_SRC = process.env.SKILLS_SRC_DIR ?? "/app/skills";

export async function seedSkills(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(SKILLS_SRC);
  } catch {
    console.log(`[boot] no skills source at ${SKILLS_SRC} — skipping seed (local dev?)`);
    return;
  }
  const dest = join(CLAUDE_HOME, ".claude", "skills");
  await mkdir(dest, { recursive: true });
  for (const name of entries) {
    await cp(join(SKILLS_SRC, name), join(dest, name), { recursive: true, force: true });
  }
  console.log(`[boot] seeded ${entries.length} skill(s) into ${dest}: ${entries.join(", ")}`);
}

// The headless Codex CLI config is repo-owned too: server/codex-config.toml
// (baked at /app/codex-config.toml) → $CODEX_HOME/config.toml on every boot, so
// the GPT lane's model/effort/tier track the repo like the skills do. Only
// config.toml is written; auth.json and the rest of ~/.codex are untouched.
const CODEX_CONFIG_SRC = process.env.CODEX_CONFIG_SRC ?? "/app/codex-config.toml";

export async function seedCodexConfig(): Promise<void> {
  if (!existsSync(CODEX_CONFIG_SRC)) return; // local dev
  const dest = join(process.env.CODEX_HOME ?? join(CLAUDE_HOME, ".codex"), "config.toml");
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(CODEX_CONFIG_SRC, dest);
  console.log(`[boot] seeded Codex config into ${dest}`);
}
