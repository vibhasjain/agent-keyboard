// One-click self-host, M1 (Notes: "11 One-click self-host"): POST /setup/deploy
// creates an Agent Keyboard instance in the CALLER's Fly org from the public
// GHCR image. It drives flyctl with the caller's token in a throwaway HOME, so
// this server's own Fly credentials and config are never involved. Tokens and
// secrets live only in this request's memory: never logged, stored or returned.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router, type Request } from "express";
import { loadSites } from "./config.js";

export const SETUP_IMAGE = process.env.AK_SETUP_IMAGE ?? "ghcr.io/vibhasjain/agent-keyboard:latest";
const REQUIRED = [
  "SITES", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_KEY",
  "ALLOWED_EMAIL", "GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

// 5 attempts per IP per hour, 2 installs at once (each runs a flyctl deploy).
const hits = new Map<string, number[]>();
let running = 0;
function limited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 5;
}

/** The generic half of server/fly.toml: no owner-specific env (Tailscale, Google, email). */
export function flyToml(app: string, region: string): string {
  return `app = "${app}"
primary_region = "${region}"
swap_size_mb = 1024

[env]
  PORT = "8080"
  AK_MAX_WORKERS = "2"
  HOME = "/data"
  IS_SANDBOX = "1"
  NODE_ENV = "production"
  AK_SESSION_IDLE_MS = "45000"
  AK_PUBLIC_URL = "https://${app}.fly.dev"
  AK_IMAGE = "${SETUP_IMAGE}"
  GIT_AUTHOR_NAME = "Agent Keyboard"
  GIT_COMMITTER_NAME = "Agent Keyboard"
  GIT_AUTHOR_EMAIL = "agent@agentkeyboard.com"
  GIT_COMMITTER_EMAIL = "agent@agentkeyboard.com"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

[[mounts]]
  source = "agent_data"
  destination = "/data"

[[vm]]
  size = "shared-cpu-1x"
  memory = "1gb"
`;
}

type Input = { flyToken: string; app: string; region: string; org: string; secrets: Record<string, string> };

/** Validate the body; returns an error message or the clean input. */
export function parseInput(body: unknown): string | Input {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const flyToken = str(b.flyToken);
  const app = str(b.app);
  const region = str(b.region) || "iad";
  const org = str(b.org) || "personal";
  if (!flyToken) return "flyToken is required";
  if (!/^[a-z][a-z0-9-]{1,40}[a-z0-9]$/.test(app)) return "app must be 3-42 chars: lowercase letters, digits, dashes";
  if (!/^[a-z]{3}$/.test(region)) return "region must be a 3-letter Fly region code, e.g. iad";
  if (!/^[a-z0-9-]{1,64}$/.test(org)) return "org must be a Fly org slug, e.g. personal";
  const raw = (b.secrets ?? {}) as Record<string, unknown>;
  const secrets: Record<string, string> = {};
  for (const k of REQUIRED) {
    const v = str(raw[k]);
    if (!v) return `${k} is required`;
    if (/[\r\n]/.test(v)) return `${k} must be one line`;
    secrets[k] = v;
  }
  try {
    loadSites(secrets.SITES);
  } catch (e) {
    return (e as Error).message;
  }
  return { flyToken, app, region, org, secrets };
}

type Step = { step: string; ok: boolean; detail?: string };

/** Run every step; idempotent, so a failed install can simply be re-run. */
export async function deploy(input: Input): Promise<{ ok: boolean; url?: string; steps: Step[] }> {
  const home = await mkdtemp(join(tmpdir(), "ak-setup-"));
  const hide = [input.flyToken, ...Object.values(input.secrets)];
  const redact = (s: string) => hide.reduce((out, v) => out.split(v).join("[hidden]"), s).trim().slice(-600);
  const env = { PATH: process.env.PATH ?? "", HOME: home, FLY_API_TOKEN: input.flyToken, FLY_NO_UPDATE_CHECK: "1" };
  const fly = (args: string[], stdin?: string, timeout = 120_000) =>
    new Promise<{ ok: boolean; out: string }>((resolve) => {
      const child = execFile("flyctl", args, { env, timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) =>
        resolve({ ok: !err, out: `${stdout}\n${stderr}` }),
      );
      child.stdin?.on("error", () => {}); // flyctl may exit before reading; an EPIPE must not crash the server
      child.stdin?.end(stdin ?? "");
    });
  const steps: Step[] = [];
  const fail = (step: string, out: string) => {
    steps.push({ step, ok: false, detail: redact(out) });
    return { ok: false, steps };
  };
  const a = ["-a", input.app];
  try {
    if (!(await fly(["status", ...a])).ok) {
      const r = await fly(["apps", "create", input.app, "-o", input.org, "-y"]);
      if (!r.ok) return fail("create app", r.out);
    }
    steps.push({ step: "create app", ok: true });

    const vols = await fly(["volumes", "list", ...a, "--json"]);
    if (!vols.ok) return fail("create volume", vols.out);
    if (!/"name":\s*"agent_data"/.test(vols.out)) {
      const r = await fly(["volumes", "create", "agent_data", "--size", "1", "--region", input.region, "-y", ...a]);
      if (!r.ok) return fail("create volume", r.out);
    }
    steps.push({ step: "create volume", ok: true });

    // An app-scoped token for "update yourself", so the instance never holds the org token.
    const tok = await fly(["tokens", "create", "deploy", ...a, "-n", "agent-keyboard self-update", "-j"]);
    const deployToken = tok.ok ? /"token":\s*"([^"]+)"/.exec(tok.out)?.[1] ?? /^FlyV1 \S+$/m.exec(tok.out)?.[0] : undefined;
    if (!deployToken) return fail("create update token", tok.out);
    hide.push(deployToken);
    steps.push({ step: "create update token", ok: true });

    const pairs = { ...input.secrets, FLY_API_TOKEN: deployToken };
    const sec = await fly(["secrets", "import", "--stage", ...a], Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join("\n"));
    if (!sec.ok) return fail("set secrets", sec.out);
    steps.push({ step: "set secrets", ok: true });

    await writeFile(join(home, "fly.toml"), flyToml(input.app, input.region));
    const dep = await fly(
      ["deploy", "--config", join(home, "fly.toml"), "--image", SETUP_IMAGE, "--ha=false", "-y", ...a],
      undefined,
      600_000,
    );
    if (!dep.ok) return fail("deploy", dep.out);
    steps.push({ step: "deploy", ok: true });
    return { ok: true, url: `https://${input.app}.fly.dev`, steps };
  } catch (e) {
    return fail("setup", String(e));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const clientIp = (req: Request) => req.header("fly-client-ip") ?? req.ip ?? "?";

export function setupRouter(): Router {
  const r = Router();
  r.post("/setup/deploy", async (req, res) => {
    if (limited(clientIp(req))) return void res.status(429).json({ error: "too many attempts, try again in an hour" });
    const input = parseInput(req.body);
    if (typeof input === "string") return void res.status(400).json({ error: input });
    if (running >= 2) return void res.status(503).json({ error: "the installer is busy, try again in a few minutes" });
    running++;
    try {
      const out = await deploy(input);
      res.status(out.ok ? 200 : 502).json(out);
    } finally {
      running--;
    }
  });
  return r;
}
