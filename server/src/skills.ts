// Seed the repo-shipped skills (server/skills/*, baked into the image at
// /app/skills) into ~/.claude/skills on the volume at boot. force:true so a
// deploy updates repo skills in place; other directories are never touched, so
// skills the agent installs itself persist across deploys.

import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
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
