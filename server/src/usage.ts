// Claude + Codex weekly % left → wa-bridge `POST /v1/usage`, for the footer of
// the Instinct lock-screen Live Activity. Runs here because this box holds both
// subscription logins; nothing depends on the owner's Mac being awake.
//
// - Claude: a 1-token Haiku call with CLAUDE_CODE_OAUTH_TOKEN; the reply's
//   `anthropic-ratelimit-unified-7d-utilization` header is the weekly usage.
// - Codex: `codex app-server` → `account/rateLimits/read` (the CLI refreshes its
//   own login; never copy auth.json between machines — a refresh token is
//   single-use, so two copies knock each other out).
import { spawn } from "node:child_process";

const EVERY_MS = 10 * 60_000;

export async function claudeWeeklyLeft(): Promise<number | undefined> {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) return undefined;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "." }] }),
    signal: AbortSignal.timeout(30_000),
  });
  void res.body?.cancel();
  const used = Number(res.headers.get("anthropic-ratelimit-unified-7d-utilization"));
  return res.headers.has("anthropic-ratelimit-unified-7d-utilization") ? left(used * 100) : undefined;
}

export function codexWeeklyLeft(): Promise<number | undefined> {
  return new Promise((resolve) => {
    const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    const done = (v: number | undefined) => {
      clearTimeout(timer);
      child.kill();
      resolve(v);
    };
    const timer = setTimeout(() => done(undefined), 60_000);
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        let msg: { id?: number; result?: { rateLimits?: Record<string, { usedPercent?: number; windowDurationMins?: number } | null> } };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== 2) continue;
        const rl = msg.result?.rateLimits ?? {};
        const weekly = [rl.primary, rl.secondary].find((w) => w?.windowDurationMins === 10080);
        return done(weekly?.usedPercent == null ? undefined : left(weekly.usedPercent));
      }
    });
    child.on("error", () => done(undefined));
    const send = (m: object) => child.stdin.write(JSON.stringify(m) + "\n");
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "agent-keyboard-usage", version: "1" } } });
    send({ method: "initialized" });
    send({ id: 2, method: "account/rateLimits/read" });
  });
}

const left = (usedPct: number) => Math.max(0, Math.min(100, Math.round(100 - usedPct)));

async function pushUsage(): Promise<void> {
  const bridge = process.env.WA_BRIDGE_URL, token = process.env.WA_API_TOKEN;
  if (!bridge || !token) return;
  const [claude, codex] = await Promise.all([
    claudeWeeklyLeft().catch(() => undefined),
    codexWeeklyLeft(),
  ]);
  if (claude == null && codex == null) return console.error("[usage] no reading from Claude or Codex");
  const res = await fetch(new URL("/v1/usage", bridge), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ claude, codex }),
    signal: AbortSignal.timeout(15_000),
  });
  void res.body?.cancel();
  console.log(`[usage] claude ${claude ?? "?"}% codex ${codex ?? "?"}% left -> bridge ${res.status}`);
}

export function startUsagePush(): void {
  const tick = () => void pushUsage().catch((e) => console.error("[usage] push failed", String(e)));
  tick();
  setInterval(tick, EVERY_MS).unref();
}
