// Central config: everything owner-specific comes from the environment, loaded
// and validated once at boot. Nothing owner-specific is baked into the tree —
// the sites the agent may edit, the allowed email, and the Supabase/GitHub
// credentials all arrive as env vars (see SELF_HOSTING.md). assertServerConfig()
// runs first thing in index.ts and refuses to start, with one readable error
// block, if anything required is missing or malformed.

export interface Site {
  id: string;
  repo: string; // https clone URL ending .git (token is injected at clone/sync time)
  branch: string;
  domain: string; // bare host, no scheme
  // Optional safety valve: publish the agent's commit to THIS branch (a review
  // branch) instead of the deploy `branch`. Absent = push straight to `branch`.
  // May contain the literal {ts} placeholder, substituted per job with a UTC
  // stamp (e.g. "agent-keyboard/{ts}" → a fresh branch each change). See claude.ts.
  pushBranch?: string;
  // Opt-in per-page sessions; root "/" keeps the site conversation. Absent or
  // "site" = one conversation per site, unchanged.
  sessionScope?: "site" | "page";
  /** Shared with invited guests: the owner's personal credentials and skills are
   *  withheld from this site's agent, and other sites' files are denied. */
  guest?: boolean;
}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/i;
// A bare host: dot-separated alnum/hyphen labels — no scheme, no slash, no port.
const HOST_RE = /^(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

// A conservative git branch name: alnum plus - _ . /, optionally carrying the
// literal {ts} placeholder (replaced with a timestamp at job time). Rejects the
// shapes `git check-ref-format` forbids that a fat-finger is likely to produce.
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
function isValidBranchName(name: string): boolean {
  const probe = name.replace(/\{ts\}/g, "00000000-000000");
  if (!BRANCH_RE.test(probe)) return false;
  if (probe.startsWith("-") || probe.startsWith("/") || probe.endsWith("/")) return false;
  if (probe.includes("..") || probe.includes("//")) return false;
  if (probe.endsWith(".lock")) return false;
  return true;
}

const SITES_EXAMPLE =
  `SITES='[{"id":"blog","repo":"https://github.com/you/blog.git","branch":"main","domain":"blog.example.com"}]'`;

function isUrl(s: string): boolean {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse + validate the SITES env var (a JSON array of {id,repo,branch,domain}).
 * Throws an Error naming the offending entry, with a correct example, on any
 * problem. The result is the allow-list: the agent may only ever operate on one
 * of these checkouts, never an arbitrary repo.
 */
export function loadSites(): Site[] {
  const raw = process.env.SITES ?? "";
  if (!raw.trim()) {
    throw new Error(`SITES is empty. Set a JSON array, e.g. ${SITES_EXAMPLE}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`SITES is not valid JSON (${(e as Error).message}). Expected e.g. ${SITES_EXAMPLE}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`SITES must be a non-empty JSON array, e.g. ${SITES_EXAMPLE}`);
  }

  const sites: Site[] = [];
  const seen = new Set<string>();
  parsed.forEach((entry, i) => {
    const at = `SITES[${i}]`;
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${at} must be an object, e.g. ${SITES_EXAMPLE}`);
    }
    const { id, repo, branch, domain, pushBranch, sessionScope, guest } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !ID_RE.test(id)) {
      throw new Error(`${at}.id ${JSON.stringify(id)} must be a slug like "blog" (letters, digits, hyphens)`);
    }
    if (seen.has(id)) {
      throw new Error(`SITES has a duplicate id ${JSON.stringify(id)} — every id must be unique`);
    }
    if (typeof repo !== "string" || !/^https:\/\/.+\.git$/.test(repo) || !isUrl(repo)) {
      throw new Error(
        `${at}.repo must be an https:// clone URL ending in .git (e.g. "https://github.com/you/blog.git"), got ${JSON.stringify(repo)}`,
      );
    }
    if (typeof branch !== "string" || !branch.trim()) {
      throw new Error(`${at}.branch must be a non-empty branch name (e.g. "main"), got ${JSON.stringify(branch)}`);
    }
    if (typeof domain !== "string" || !HOST_RE.test(domain)) {
      throw new Error(
        `${at}.domain must be a bare host with no scheme or path (e.g. "blog.example.com"), got ${JSON.stringify(domain)}`,
      );
    }
    if (guest !== undefined && typeof guest !== "boolean") {
      throw new Error(`${at}.guest, if set, must be true or false, got ${JSON.stringify(guest)}`);
    }
    if (sessionScope !== undefined && sessionScope !== "site" && sessionScope !== "page") {
      throw new Error(
        `${at}.sessionScope, if set, must be "site" or "page", got ${JSON.stringify(sessionScope)}`,
      );
    }
    let pushBranchClean: string | undefined;
    if (pushBranch !== undefined && pushBranch !== null && pushBranch !== "") {
      if (typeof pushBranch !== "string" || !pushBranch.trim()) {
        throw new Error(
          `${at}.pushBranch, if set, must be a non-empty branch name (e.g. "agent-keyboard" or "agent-keyboard/{ts}"), got ${JSON.stringify(pushBranch)}`,
        );
      }
      if (!isValidBranchName(pushBranch)) {
        throw new Error(
          `${at}.pushBranch ${JSON.stringify(pushBranch)} is not a valid git branch name (letters, digits, and . _ / - only; may contain the {ts} placeholder)`,
        );
      }
      if (pushBranch === branch) {
        throw new Error(
          `${at}.pushBranch must differ from branch ${JSON.stringify(branch)} — point it at a separate review branch, or omit it to push straight to ${JSON.stringify(branch)}`,
        );
      }
      pushBranchClean = pushBranch;
    }
    seen.add(id);
    sites.push({
      id,
      repo,
      branch,
      domain,
      ...(pushBranchClean ? { pushBranch: pushBranchClean } : {}),
      ...(sessionScope === "page" ? { sessionScope } : {}),
      ...(guest === true ? { guest: true } : {}),
    });
  });
  return sites;
}

// Required config, in the order we report it. SITES is validated separately
// (below) so its error names the exact bad entry.
const REQUIRED: { name: string; hint: string }[] = [
  { name: "ALLOWED_EMAIL", hint: "the email(s) allowed to drive the agent — one, or a comma-separated few" },
  { name: "SUPABASE_URL", hint: "your Supabase project URL, e.g. https://xxxx.supabase.co" },
  { name: "SUPABASE_ANON_KEY", hint: "the Supabase anon/public key (safe to expose; RLS + the owner gate protect writes)" },
  { name: "GH_TOKEN", hint: "a fine-grained GitHub PAT with push access to the site repos" },
];

const LABEL_W = 16;
const label = (name: string): string => name.padEnd(Math.max(LABEL_W, name.length + 2));
const CONT = " ".repeat(2 + LABEL_W); // continuation indent, under the hint column

/**
 * Validate everything the server needs from the environment. Collects ALL
 * problems, prints one stderr block, and exits(1). Called first thing at boot,
 * before route setup, so a misconfigured deploy fails loudly and actionably.
 */
export function assertServerConfig(): void {
  const problems: { name: string; hint: string }[] = [];

  // SITES first: present, and parses + validates.
  if (!process.env.SITES?.trim()) {
    problems.push({ name: "SITES", hint: `one-line JSON array of the sites the agent may edit, e.g.\n${CONT}${SITES_EXAMPLE}` });
  } else {
    try {
      loadSites();
    } catch (e) {
      problems.push({ name: "SITES", hint: `invalid — ${(e as Error).message}` });
    }
  }
  for (const r of REQUIRED) {
    if (!process.env[r.name]?.trim()) problems.push(r);
  }

  if (problems.length) {
    const lines = problems.map((p) => `  ${label(p.name)}${p.hint}`);
    process.stderr.write(
      `agent-keyboard: missing required config:\n${lines.join("\n")}\n\nSee SELF_HOSTING.md for the full setup guide.\n`,
    );
    process.exit(1);
  }

  // Optional-but-recommended: degrade a feature, don't refuse to boot.
  const warn = (name: string, effect: string): void => {
    if (!process.env[name]?.trim()) process.stderr.write(`agent-keyboard: ${name} unset — ${effect}\n`);
  };
  warn("SUPABASE_SERVICE_KEY", "job persistence disabled — reloaded clients can't re-attach; user provisioning disabled too");
  warn("OPENAI_API_KEY", "voice dictation disabled");
  warn("CLAUDE_CODE_OAUTH_TOKEN", "Claude Code CLI has no auth — jobs will fail (run `claude setup-token`)");
  warn("GEMINI_API_KEY", "image-generation skill disabled — the agent can't generate images");
  warn("AK_PUBLIC_URL", "user-provisioning invite links fall back to the Supabase project's Site URL instead of this server's /welcome page");
}
