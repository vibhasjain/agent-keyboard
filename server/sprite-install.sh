#!/usr/bin/env bash
# Install Agent Keyboard on a Fly.io Sprite and run it as the "ak" service on :8080.
# Run on the Sprite (the control plane does it over exec). ~/ak.env must already
# hold the server's env (SITES, SUPABASE_*, ALLOWED_EMAIL, AGENT_DATA_DIR, ...).
# Idempotent: re-running updates to AK_REF and restarts the service.
# Prints the deploy key's public half last; add it to the site repo with write access.
set -euo pipefail
REF="${AK_REF:-main}"
DIR="$HOME/agent-keyboard"
export PATH="$HOME/.local/bin:$PATH"

for bin in node npm git claude ssh-keygen; do
  command -v "$bin" >/dev/null || { echo "sprite-install: $bin not found" >&2; exit 1; }
done
[ -f "$HOME/ak.env" ] || { echo "sprite-install: ~/ak.env missing" >&2; exit 1; }

# Deploy key: generated here, only the public half ever leaves the Sprite.
mkdir -p -m 700 "$HOME/.ssh"
[ -f "$HOME/.ssh/id_ed25519" ] || ssh-keygen -q -t ed25519 -N "" -C "agent-keyboard@$(hostname)" -f "$HOME/.ssh/id_ed25519"
grep -q '^github.com ' "$HOME/.ssh/known_hosts" 2>/dev/null || ssh-keyscan -t ed25519 github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null

sudo mkdir -p /data && sudo chown "$(id -u):$(id -g)" /data

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q --depth 1 origin "$REF" && git -C "$DIR" checkout -q FETCH_HEAD
else
  git clone -q https://github.com/vibhasjain/agent-keyboard.git "$DIR"
  git -C "$DIR" checkout -q "$REF"
fi
(cd "$DIR/widget" && npm ci --silent && npm run build --silent)
(cd "$DIR/server" && npm ci --silent --omit=dev)

cat > "$HOME/ak-run.sh" <<'EOF'
#!/usr/bin/env bash
set -a; . "$HOME/ak.env"; set +a
export PATH="$HOME/.local/bin:$PATH"
export SKILLS_SRC_DIR="$HOME/agent-keyboard/server/skills"
export WIDGET_JS_PATH="$HOME/agent-keyboard/widget/dist/widget.js"
cd "$HOME/agent-keyboard/server" && exec npx tsx src/index.ts
EOF
chmod +x "$HOME/ak-run.sh"

sprite-env services delete ak >/dev/null 2>&1 || true
sprite-env services create ak --cmd "$HOME/ak-run.sh" --http-port 8080 >/dev/null

for _ in $(seq 60); do
  curl -sf localhost:8080/health >/dev/null && break
  sleep 2
done
curl -sf localhost:8080/health >/dev/null || { echo "sprite-install: server did not come up" >&2; exit 1; }
cat "$HOME/.ssh/id_ed25519.pub"
