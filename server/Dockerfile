# Agent Keyboard server — the real Claude Code CLI driven headless on Fly.
#
# Build context MUST be the HALO REPO ROOT (so the widget/ dir is available to
# the widget build stage). Deploy with:
#   flyctl deploy . --config server/fly.toml --dockerfile server/Dockerfile

# ---- widget bundle builder ----
# The widget/ dir is built in parallel; assume `npm ci && npm run build` emits
# dist/widget.js. The main stage copies just that one file.
FROM node:22-slim AS widget
WORKDIR /w
COPY widget/ ./
RUN npm ci && npm run build

# ---- runtime ----
FROM node:22-slim AS runner
ENV HOME=/data \
    IS_SANDBOX=1 \
    NODE_ENV=production \
    PORT=8080

# git (checkout + commit + push), ripgrep/jq/python3 for the agent's toolbelt,
# xauth (xvfb-run needs it to fake a display for the headed-Playwright submit path).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git ripgrep jq python3 xauth \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI (gh) from the official apt repo (not in Debian default).
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Tailscale, for the LinkedIn-only residential egress (tailscale-up.sh, started
# at boot). In the image, not the volume: Fly resets the root fs on restart.
RUN curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg \
      -o /usr/share/keyrings/tailscale-archive-keyring.gpg \
    && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.tailscale-keyring.list \
      -o /etc/apt/sources.list.d/tailscale.list \
    && apt-get update && apt-get install -y --no-install-recommends tailscale \
    && rm -rf /var/lib/apt/lists/*

# The real Claude Code CLI (pinned).
RUN npm install -g @anthropic-ai/claude-code@2.1.261

# OpenAI Codex CLI (pinned) — the GPT lane for the fable-subagents skill and the
# codex plugin (/codex:rescue). Login lives on the volume: /data/.codex/auth.json.
RUN npm install -g @openai/codex@0.153.4

# Supabase CLI (pinned). Logged in per site via SUPABASE_ACCESS_TOKEN in that
# site's settings.json "env" knob (harness.ts) — each site's own Supabase account.
RUN curl -fsSL -o /tmp/supabase.deb \
      "https://github.com/supabase/cli/releases/download/v2.109.1/supabase_2.109.1_linux_$(dpkg --print-architecture).deb" \
    && apt-get install -y --no-install-recommends /tmp/supabase.deb && rm -f /tmp/supabase.deb \
    && rm -rf /var/lib/apt/lists/*

# Headless browser for the agent's verify-in-browser skill. Browsers install to
# an IMAGE path — at runtime HOME=/data (the volume) and the Playwright default
# ($HOME/.cache/ms-playwright) would resolve to a place they were never
# installed. chromium-headless-shell keeps the footprint down (~350-450 MB with
# system deps); the /data volume is unaffected (image layers live in rootfs).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install -g playwright@1.58.2 \
    && playwright install --with-deps chromium-headless-shell \
    && rm -rf /var/lib/apt/lists/*

# flyctl, so the agent can operate its own Fly app (logs, status, secrets) when
# the optional FLY_API_TOKEN secret is set. Pinned install dir — HOME=/data at
# runtime, so the default $HOME/.fly would land on the volume.
RUN curl -fsSL https://fly.io/install.sh | FLYCTL_INSTALL=/usr/local sh

# Server dependencies (express, cors, busboy, sharp, uuid, tsx). sharp pulls its
# linux native binary during npm ci in this stage.
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/tsconfig.json ./
COPY server/src ./src

# Repo-shipped agent skills (image-gen, verify-in-browser, provision-user,
# self-ops, frontend-design, ponytail, fable-subagents) — seeded into /data/.claude/skills at boot
# (see src/skills.ts). Below npm ci so a skill edit doesn't bust the dependency
# layer (sharp's native build).
COPY server/skills /app/skills
COPY server/tailscale-up.sh /app/tailscale-up.sh

# Headless Codex CLI defaults — written to $HOME/.codex/config.toml on every
# boot (src/skills.ts seedCodexConfig), so the GPT lane's model/effort/tier
# track the repo like the skills do.
COPY server/codex-config.toml /app/codex-config.toml

# Branded invite/recovery email templates — the provision-user skill reads them
# from /app/email-templates on every deployment (they aren't in a site's checkout,
# so without this the branded invite falls back to an improvised template).
COPY server/email-templates /app/email-templates

# The widget bundle served at GET /widget.js, and the demo bundle at /demo.js.
COPY --from=widget /w/dist/widget.js /app/widget/widget.js
COPY --from=widget /w/dist/demo.js /app/widget/demo.js

EXPOSE 8080
CMD ["npx", "tsx", "src/index.ts"]
