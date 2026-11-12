// One-click self-host (Notes: "11 One-click self-host"), the routes behind
// site/setup.html. POST /setup/supabase creates the caller's Supabase project
// (auth locked down, jobs table, owner login); POST /setup/deploy creates an
// Agent Keyboard instance in the CALLER's Fly org from the public GHCR image,
// driving flyctl with the caller's token in a throwaway HOME so this server's
// own Fly credentials are never involved; GET /setup/health checks the result.
// Tokens and secrets live only in a request's memory: never logged, stored or returned.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router, type Request } from "express";
import { loadSites } from "./config.js";

export const SETUP_IMAGE = process.env.AK_SETUP_IMAGE ?? "ghcr.io/vibhasjain/agent-keyboard:latest";
const REQUIRED = ["SITES", "ALLOWED_EMAIL", "GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
const SB_API = "https://api.supabase.com/v1";
const SB_PROJECT = "agent-keyboard";

// 10 Supabase/deploy attempts per IP per hour, 2 running at once.
const hits = new Map<string, number[]>();
let running = 0;
function limited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 10;
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

type Input = {
  flyToken: string; app: string; region: string; org: string;
  supabaseToken: string; supabaseRef: string; secrets: Record<string, string>;
};

/** Validate the body; returns an error message or the clean input. */
export function parseInput(body: unknown): string | Input {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const flyToken = str(b.flyToken);
  const app = str(b.app);
  const region = str(b.region) || "iad";
  const org = str(b.org) || "personal";
  const supabaseToken = str(b.supabaseToken);
  const supabaseRef = str(b.supabaseRef);
  if (!flyToken) return "flyToken is required";
  if (!supabaseToken) return "supabaseToken is required";
  if (!/^[a-z0-9]{10,40}$/.test(supabaseRef)) return "supabaseRef is missing: run the Supabase step first";
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
  return { flyToken, app, region, org, supabaseToken, supabaseRef, secrets };
}

type Step = { step: string; ok: boolean; detail?: string };

/** Run every step; idempotent, so a failed install can simply be re-run. */
export async function deploy(input: Input): Promise<{ ok: boolean; url?: string; steps: Step[] }> {
  const home = await mkdtemp(join(tmpdir(), "ak-setup-"));
  const hide = [input.flyToken, input.supabaseToken, ...Object.values(input.secrets)];
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
    const keys = await sbKeys(input.supabaseToken, input.supabaseRef);
    if (typeof keys === "string") return fail("read Supabase keys", keys);
    hide.push(keys.anon, keys.service);
    steps.push({ step: "read Supabase keys", ok: true });

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

    const pairs = {
      ...input.secrets,
      SUPABASE_URL: `https://${input.supabaseRef}.supabase.co`,
      SUPABASE_ANON_KEY: keys.anon,
      SUPABASE_SERVICE_KEY: keys.service,
      AK_INTERNAL_SECRET: randomBytes(32).toString("hex"), // lets the agent create sandboxes
      FLY_API_TOKEN: deployToken,
    };
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

/** Call the Supabase Management API; returns the parsed body or an error message. */
async function sb(token: string, path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(SB_API + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

/** The project's anon + service keys (legacy JWT keys first, else the new publishable/secret ones). */
async function sbKeys(token: string, ref: string): Promise<string | { anon: string; service: string }> {
  try {
    const list = (await sb(token, `/projects/${ref}/api-keys?reveal=true`)) as { name: string; type?: string; api_key: string }[];
    const pick = (name: string, type: string) =>
      list.find((k) => k.name === name)?.api_key ?? list.find((k) => k.type === type)?.api_key;
    const anon = pick("anon", "publishable");
    const service = pick("service_role", "secret");
    return anon && service ? { anon, service } : "the project has no anon/service_role keys yet; retry in a minute";
  } catch (e) {
    return (e as Error).message;
  }
}

/** Fly region → the nearest Supabase region. */
function sbRegion(fly: string): string {
  if (/^(ams|arn|cdg|fra|jnb|waw|mad|otp)$/.test(fly)) return "eu-central-1";
  if (fly === "lhr") return "eu-west-2";
  if (/^(sin|hkg|bom)$/.test(fly)) return "ap-southeast-1";
  if (fly === "nrt") return "ap-northeast-1";
  if (fly === "syd") return "ap-southeast-2";
  if (fly === "gru") return "sa-east-1";
  if (/^(sjc|lax|sea|den)$/.test(fly)) return "us-west-1";
  return "us-east-1";
}

type SbInput = { supabaseToken: string; email: string; password: string; region: string; domain: string };

export function parseSbInput(body: unknown): string | SbInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const supabaseToken = str(b.supabaseToken);
  const email = str(b.email).toLowerCase();
  const password = typeof b.password === "string" ? b.password : "";
  const region = str(b.region) || "iad";
  const domain = str(b.domain);
  if (!supabaseToken) return "supabaseToken is required";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "a valid email is required";
  if (password.length < 8) return "password must be at least 8 characters";
  if (!/^[a-z]{3}$/.test(region)) return "region must be a 3-letter Fly region code, e.g. iad";
  if (!/^(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(domain)) return "domain must be a bare host like blog.example.com";
  return { supabaseToken, email, password, region, domain };
}

/** Create (or reuse) the "agent-keyboard" project, lock sign-up, add the jobs table and the owner login. */
export async function setupSupabase(input: SbInput): Promise<{ ok: boolean; ref?: string; steps: Step[] }> {
  const steps: Step[] = [];
  const hide = [input.supabaseToken, input.password];
  const fail = (step: string, e: unknown) => {
    const msg = hide.reduce((out, v) => out.split(v).join("[hidden]"), String((e as Error)?.message ?? e));
    steps.push({ step, ok: false, detail: msg.slice(0, 600) });
    return { ok: false, steps };
  };
  const t = input.supabaseToken;
  let ref: string;
  try {
    const projects = (await sb(t, "/projects")) as { id: string; name: string }[];
    ref = projects.find((p) => p.name === SB_PROJECT)?.id ?? "";
    if (!ref) {
      const org = ((await sb(t, "/organizations")) as { id: string; slug?: string }[])[0];
      if (!org) throw new Error("this Supabase account has no organization; create one at supabase.com first");
      const created = await sb(t, "/projects", {
        method: "POST",
        body: JSON.stringify({
          name: SB_PROJECT,
          organization_id: org.slug ?? org.id,
          region: sbRegion(input.region),
          db_pass: randomBytes(24).toString("base64url"),
        }),
      });
      ref = created.id ?? created.ref;
    }
    steps.push({ step: "create project", ok: true });
  } catch (e) {
    return fail("create project", e);
  }
  try {
    for (let i = 0; ; i++) {
      const p = await sb(t, `/projects/${ref}`);
      if (p.status === "ACTIVE_HEALTHY") break;
      if (i >= 60) throw new Error(`project is still ${p.status} after 5 minutes; retry shortly`);
      await new Promise((r) => setTimeout(r, 5000));
    }
    steps.push({ step: "wait for project", ok: true });
  } catch (e) {
    return fail("wait for project", e);
  }
  try {
    // Sign-up off: the anon key is public, so the only accounts are the ones made here or by invite.
    await sb(t, `/projects/${ref}/config/auth`, {
      method: "PATCH",
      body: JSON.stringify({ disable_signup: true, site_url: `https://${input.domain}`, uri_allow_list: `https://${input.domain}/**` }),
    });
    steps.push({ step: "lock sign-up", ok: true });
  } catch (e) {
    return fail("lock sign-up", e);
  }
  try {
    const sql = await readFile(new URL("../sql/jobs.sql", import.meta.url), "utf8");
    await sb(t, `/projects/${ref}/database/query`, { method: "POST", body: JSON.stringify({ query: sql }) });
    steps.push({ step: "create jobs table", ok: true });
  } catch (e) {
    return fail("create jobs table", e);
  }
  try {
    const keys = await sbKeys(t, ref);
    if (typeof keys === "string") throw new Error(keys);
    const auth = { apikey: keys.service, "Content-Type": "application/json",
      ...(keys.service.startsWith("eyJ") ? { Authorization: `Bearer ${keys.service}` } : {}) };
    const r = await fetch(`https://${ref}.supabase.co/auth/v1/admin/users`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ email: input.email, password: input.password, email_confirm: true }),
      signal: AbortSignal.timeout(30_000),
    });
    // Already there (a re-run): keep it, the owner's password stays as first set.
    if (!r.ok && r.status !== 422) throw new Error(`Supabase auth ${r.status}: ${(await r.text()).slice(0, 300)}`);
    steps.push({ step: "create your login", ok: true });
  } catch (e) {
    return fail("create your login", e);
  }
  return { ok: true, ref, steps };
}

const clientIp = (req: Request) => req.header("fly-client-ip") ?? req.ip ?? "?";

export function setupRouter(): Router {
  const r = Router();
  r.post("/setup/supabase", async (req, res) => {
    if (limited(clientIp(req))) return void res.status(429).json({ error: "too many attempts, try again in an hour" });
    const input = parseSbInput(req.body);
    if (typeof input === "string") return void res.status(400).json({ error: input });
    const out = await setupSupabase(input);
    res.status(out.ok ? 200 : 502).json(out);
  });
  // Is the new instance up? (The page can't fetch it directly: its CORS only allows the user's site.)
  r.get("/setup/health", async (req, res) => {
    const app = String(req.query.app ?? "");
    if (!/^[a-z][a-z0-9-]{1,40}[a-z0-9]$/.test(app)) return void res.status(400).json({ error: "bad app name" });
    try {
      const h = await fetch(`https://${app}.fly.dev/health`, { signal: AbortSignal.timeout(8000) });
      const body = (await h.json().catch(() => ({}))) as { service?: string };
      res.json({ ok: h.ok && body.service === "agent-keyboard" });
    } catch {
      res.json({ ok: false });
    }
  });
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
