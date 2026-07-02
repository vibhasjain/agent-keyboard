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

# git (checkout + commit + push), ripgrep/jq/python3 for the agent's toolbelt.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git ripgrep jq python3 \
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

# The real Claude Code CLI (pinned).
RUN npm install -g @anthropic-ai/claude-code@2.1.170

# Server dependencies (express, cors, busboy, sharp, uuid, tsx). sharp pulls its
# linux native binary during npm ci in this stage.
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/tsconfig.json ./
COPY server/src ./src

# The widget bundle served at GET /widget.js.
COPY --from=widget /w/dist/widget.js /app/widget/widget.js

EXPOSE 8080
CMD ["npx", "tsx", "src/index.ts"]
