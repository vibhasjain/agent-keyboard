// Self-test for an instance (Notes: "11 One-click self-host", M3): GET /check
// reports each piece of config by name, and index.ts logs it once at boot.
// Setting an instance up is the `self-host` skill's job (Claude Code, on the
// user's machine), so no setup route ever sees a token.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Router } from "express";
import { loadSites, type Site } from "./config.js";

type Check = { name: string; ok: boolean; detail?: string };
let lastCheck: { at: number; checks: Promise<Check[]> } | undefined;

/** End-to-end self-test of THIS instance (UX report issue 4). No secrets in the output. Cached 60 s. */
export function runChecks(): Promise<Check[]> {
  if (lastCheck && Date.now() - lastCheck.at < 60_000) return lastCheck.checks;
  lastCheck = { at: Date.now(), checks: checks() };
  return lastCheck.checks;
}

async function checks(): Promise<Check[]> {
  const env = process.env;
  const get = (url: string, headers: Record<string, string> = {}) =>
    fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  const one = async (name: string, fn: () => Promise<true | string>): Promise<Check> => {
    try {
      const r = await fn();
      return r === true ? { name, ok: true } : { name, ok: false, detail: r };
    } catch (e) {
      return { name, ok: false, detail: (e as Error).message.slice(0, 200) };
    }
  };
  const sbUrl = env.SUPABASE_URL ?? "";
  const service = env.SUPABASE_SERVICE_KEY ?? "";
  const list: Promise<Check>[] = [
    one("Supabase sign-in, sign-up off", async () => {
      const r = await get(`${sbUrl}/auth/v1/settings`, { apikey: env.SUPABASE_ANON_KEY ?? "" });
      if (!r.ok) return `Supabase answered ${r.status}: check SUPABASE_URL and SUPABASE_ANON_KEY`;
      return ((await r.json()) as { disable_signup?: boolean }).disable_signup ? true : "sign-up is on: anyone could create an account; turn it off in Supabase";
    }),
    one("job history table", async () => {
      if (!service) return "SUPABASE_SERVICE_KEY unset: jobs won't survive a restart";
      const r = await get(`${sbUrl}/rest/v1/agent_keyboard_jobs?select=job_id&limit=1`, {
        apikey: service, ...(service.startsWith("eyJ") ? { Authorization: `Bearer ${service}` } : {}),
      });
      return r.ok || `Supabase answered ${r.status}: run server/sql/jobs.sql`;
    }),
    one("Claude login", async () =>
      /^sk-ant-/.test(env.CLAUDE_CODE_OAUTH_TOKEN ?? "") || !!env.ANTHROPIC_API_KEY || existsSync(join(homedir(), ".claude", ".credentials.json")) ||
      "CLAUDE_CODE_OAUTH_TOKEN is missing or malformed: run `claude setup-token`"),
  ];
  let sites: Site[] = [];
  try { sites = loadSites(); } catch { /* boot already refused a bad SITES */ }
  for (const site of sites) {
    list.push(one(`${site.id}: can push to the repo`, async () => {
      const path = /github\.com\/(.+?)\.git$/.exec(site.repo)?.[1];
      if (!path) return true; // not GitHub: nothing to ask
      const r = await get(`https://api.github.com/repos/${path}`, { Authorization: `Bearer ${env.GH_TOKEN ?? ""}` });
      if (!r.ok) return `GitHub answered ${r.status}: give GH_TOKEN access to this repo`;
      return ((await r.json()) as { permissions?: { push?: boolean } }).permissions?.push || "GH_TOKEN can read but not push: give it Contents read/write";
    }));
    list.push(one(`${site.id}: script tag on ${site.domain}`, async () => {
      const html = await (await get(`https://${site.domain}/`)).text();
      return (html.includes("/widget.js") && html.includes(`data-site="${site.id}"`)) || `not found on the home page: paste the script tag before </body>`;
    }));
    if (site.sandbox) list.push(one(`${site.id}: sandboxes`, async () =>
      !!env.AK_INTERNAL_SECRET || "AK_INTERNAL_SECRET unset: the agent can't create sandboxes"));
  }
  return Promise.all(list);
}

export function setupRouter(): Router {
  const r = Router();
  r.get("/check", async (_req, res) => {
    const checks = await runChecks();
    res.json({ ok: checks.every((c) => c.ok), checks });
  });
  return r;
}
