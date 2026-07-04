// Provision an Agent Keyboard user: Supabase invite (or recovery for an
// existing account) + append to the server's email allow-list. Zero deps.
//   node invite.mjs <email>
// Env: SUPABASE_URL + SUPABASE_SERVICE_KEY (required), AK_PUBLIC_URL (the
// server's public base URL, for the /welcome redirect), AGENT_DATA_DIR.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const email = (process.argv[2] || "").trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("usage: node invite.mjs <email>");
  process.exit(2);
}
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_KEY not configured — provisioning is disabled on this deployment.");
  process.exit(3);
}
const PUBLIC_URL = (process.env.AK_PUBLIC_URL || "").replace(/\/$/, "");
const redirectTo = PUBLIC_URL ? `${PUBLIC_URL}/welcome` : "";

const call = (path, body) =>
  fetch(`${SUPABASE_URL}${path}${redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : ""}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

let res = await call("/auth/v1/invite", { email });
let mode = "invite";
if (!res.ok) {
  const text = await res.text();
  if (/already|exists|registered/i.test(text)) {
    // Existing account → password-recovery email (same landing: set a password).
    res = await call("/auth/v1/recover", { email });
    mode = "recovery";
    if (!res.ok) {
      console.error(`Supabase recover failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
      process.exit(1);
    }
  } else {
    console.error(`Supabase invite failed ${res.status}: ${text.slice(0, 300)}`);
    process.exit(1);
  }
}

// Add to the server's allow-list (ALLOWED_EMAIL env ∪ this file).
const dataDir = process.env.AGENT_DATA_DIR || "/data";
const listPath = join(dataDir, "agent-keyboard", "allowed-emails.json");
let list = [];
try {
  const parsed = JSON.parse(await readFile(listPath, "utf8"));
  if (Array.isArray(parsed)) list = parsed.map((e) => String(e).toLowerCase());
} catch {
  /* first user */
}
if (!list.includes(email)) list.push(email);
await mkdir(dirname(listPath), { recursive: true });
await writeFile(listPath, JSON.stringify(list, null, 2) + "\n");

console.log(
  `${mode === "invite" ? "invited" : "sent a password-setup email to existing account"} ${email}; allow-listed (${list.length} total)${redirectTo ? `; link lands on ${redirectTo}` : "; note: AK_PUBLIC_URL unset — the link uses the Supabase project's default Site URL"}`,
);
