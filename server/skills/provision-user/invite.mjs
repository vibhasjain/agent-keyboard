// Provision an Agent Keyboard user + email them a branded, site-named invite.
//   node invite.mjs <email> [site-domain]
//
// With RESEND_API_KEY set, we generate the auth link ourselves (Supabase admin
// generate_link, no email sent) and deliver a branded email from our own domain
// via Resend — so it names the exact site and we control every pixel. Without
// RESEND_API_KEY, we fall back to Supabase's built-in mailer (generic template).
//
// Env: SUPABASE_URL + SUPABASE_SERVICE_KEY (required), AK_PUBLIC_URL (the
// /welcome redirect), AGENT_DATA_DIR, and for branded delivery: RESEND_API_KEY,
// EMAIL_FROM (default "Agent Keyboard <invites@<domain>>"), SITES (to name the
// site when none is passed).

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const email = (process.argv[2] || "").trim().toLowerCase();
let siteArg = (process.argv[3] || "").trim();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("usage: node invite.mjs <email> [site-domain]");
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
const RESEND_KEY = process.env.RESEND_API_KEY || "";

// Which site is this invite for? Explicit arg wins; else the sole SITES entry's
// domain; else a friendly generic. (Access is allow-list-global, so with many
// sites we don't claim a specific one.)
function resolveSite() {
  if (siteArg) return siteArg.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  try {
    const sites = JSON.parse(process.env.SITES || "[]");
    if (Array.isArray(sites) && sites.length === 1 && sites[0]?.domain) return sites[0].domain;
  } catch {
    /* ignore */
  }
  return "your site";
}
const site = resolveSite();

const supa = (path, body) =>
  fetch(`${SUPABASE_URL}${path}`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// ── Branded path: generate the link ourselves, send via Resend ──────────────
async function generateLink(type) {
  // admin generate_link returns the action link WITHOUT sending an email.
  const res = await supa("/auth/v1/admin/generate_link", {
    type, // "invite" | "recovery"
    email,
    ...(redirectTo ? { options: { redirect_to: redirectTo } } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status, body };
  const link = body.action_link || body.properties?.action_link;
  return { ok: !!link, link, body };
}

function fillTemplate(html, url) {
  return html
    .replaceAll("%%CONFIRMATION_URL%%", url)
    .replaceAll("%%EMAIL%%", email)
    .replaceAll("%%SITE%%", site);
}

async function sendViaResend({ subject, html }) {
  // The "from" domain must be a verified Resend sender. Default to the public
  // URL's host; override with EMAIL_FROM for anything else.
  const host = (PUBLIC_URL || `https://${site}`).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const from = process.env.EMAIL_FROM || `Agent Keyboard <invites@${host}>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [email], subject, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function brandedInvite() {
  // Try invite; if the user already exists, generate a recovery link instead
  // (same landing — they set a password).
  let type = "invite";
  let gen = await generateLink("invite");
  if (!gen.ok && /already|exists|registered/i.test(JSON.stringify(gen.body))) {
    type = "recovery";
    gen = await generateLink("recovery");
  }
  if (!gen.ok) throw new Error(`generate_link failed: ${JSON.stringify(gen.body).slice(0, 200)}`);

  const file = type === "invite" ? "invite.html" : "recovery.html";
  const tpl = await readFile(join(HERE, "..", "..", "email-templates", file), "utf8").catch(async () =>
    // templates live at repo server/email-templates; also try /app layout
    readFile(join("/app", "email-templates", file), "utf8"),
  );
  const subject =
    type === "invite" ? `You're invited to edit ${site}` : `Reset your Agent Keyboard password`;
  await sendViaResend({ subject, html: fillTemplate(tpl, gen.link) });
  return type;
}

// ── Fallback path: Supabase's own mailer (generic template) ─────────────────
async function supabaseMailer() {
  const q = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : "";
  let res = await supa(`/auth/v1/invite${q}`, { email });
  let mode = "invite";
  if (!res.ok) {
    const text = await res.text();
    if (/already|exists|registered/i.test(text)) {
      res = await supa(`/auth/v1/recover${q}`, { email });
      mode = "recovery";
      if (!res.ok) throw new Error(`Supabase recover ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } else {
      throw new Error(`Supabase invite ${res.status}: ${text.slice(0, 200)}`);
    }
  }
  return mode;
}

let mode, channel;
try {
  if (RESEND_KEY) {
    mode = await brandedInvite();
    channel = "branded email via Resend";
  } else {
    mode = await supabaseMailer();
    channel = "Supabase's built-in mailer (set RESEND_API_KEY for branded, site-named emails)";
  }
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}

// Add to the server's allow-list (ALLOWED_EMAIL env ∪ this file). Atomic
// tmp+rename write — the auth gate reads this file on its hot path and a
// torn read would deny access until its cache expires.
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
await writeFile(`${listPath}.tmp`, JSON.stringify(list, null, 2) + "\n");
await rename(`${listPath}.tmp`, listPath);

if (process.env.ALLOWED_USER_ID) {
  console.error(
    "WARNING: ALLOWED_USER_ID is set on this server — it pins auth to specific user ids, so this user will STILL be rejected until the owner unsets it (or adds their id).",
  );
}

console.log(
  `${mode === "invite" ? "invited" : "sent a password-setup email to existing account"} ${email} for ${site} (${channel}); allow-listed (${list.length} total)` +
    (redirectTo ? `; link lands on ${redirectTo}` : "; note: AK_PUBLIC_URL unset — link uses Supabase's default Site URL"),
);
