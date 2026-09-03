#!/usr/bin/env sh
# LinkedIn-only Tailscale egress, started by the server at boot (src/index.ts).
#
# WHY: LinkedIn scores the Fly datacenter IP as bot traffic (redirect loops,
# reCAPTCHA on SSO, day-long 429s), and so does every proxy we tried. The fix is
# a real residential IP: an always-on iPad at the owner's office runs Tailscale
# as an exit node, and ONLY the LinkedIn browsers route through it.
#
# A dedicated USERSPACE tailscaled — no TUN device, so it cannot capture the
# box's other traffic (Claude API, git, Supabase, the ATS submitters all stay
# direct). The only way in is the SOCKS5 proxy on 127.0.0.1:1055 (HTTP proxy on
# 1056); a site's browser opts in by pointing Playwright at it.
#
# State lives on the volume, so the box joins the tailnet ONCE and is the same
# node forever — TS_AUTHKEY is only consulted on that first join. Idempotent:
# safe to re-run, exits fast when the daemon is already up.
#
# Env:  TS_AUTHKEY   Tailscale auth key (Fly secret; reusable, tagged, pre-approved).
#       TS_EXIT_NODE Node name / IP of the exit node (fly.toml [env]).
# Unset TS_AUTHKEY = this deployment doesn't use Tailscale; nothing starts.
set -eu

PORT=1055
STATE=/data/tailscale-linkedin
SOCK=$STATE/tailscaled.sock
LOG=$STATE/tailscaled.log
TS="tailscale --socket=$SOCK"

if [ -z "${TS_AUTHKEY:-}" ] && [ ! -f "$STATE/tailscaled.state" ]; then
  echo "tailscale: TS_AUTHKEY unset and no saved state — not starting"
  exit 0
fi
if [ -z "${TS_EXIT_NODE:-}" ]; then
  echo "tailscale: TS_EXIT_NODE unset — refusing to start without an exit node" >&2
  exit 1
fi

mkdir -p "$STATE"

if ! { [ -S "$SOCK" ] && $TS status >/dev/null 2>&1; }; then
  # A stale socket from a previous process would make tailscaled refuse to bind.
  rm -f "$SOCK"
  echo "tailscale: starting userspace daemon (socks5 127.0.0.1:$PORT)"
  tailscaled \
    --tun=userspace-networking \
    --socks5-server="127.0.0.1:$PORT" \
    --outbound-http-proxy-listen="127.0.0.1:$((PORT + 1))" \
    --statedir="$STATE" \
    --socket="$SOCK" \
    >>"$LOG" 2>&1 &
  i=0
  while [ ! -S "$SOCK" ] && [ $i -lt 30 ]; do i=$((i + 1)); sleep 1; done
  [ -S "$SOCK" ] || { echo "tailscale: daemon failed to start — see $LOG" >&2; exit 1; }
fi

# `up` is idempotent: after the first join the auth key is ignored and this just
# (re)pins the exit node. --reset drops any prefs a previous version set.
$TS up --reset \
  ${TS_AUTHKEY:+--authkey="$TS_AUTHKEY"} \
  --exit-node="$TS_EXIT_NODE" \
  --exit-node-allow-lan-access=false \
  --hostname=agent-keyboard-linkedin \
  --timeout=60s

# Prove the tunnel gives a different IP than the box before anyone trusts it.
DIRECT=$(curl -s --max-time 10 https://api.ipify.org || echo "?")
VIA=$(curl -s --max-time 30 --socks5-hostname "127.0.0.1:$PORT" https://api.ipify.org || echo "")
echo "tailscale: joined as agent-keyboard-linkedin, exit node $TS_EXIT_NODE: direct=$DIRECT via=$VIA"
[ -n "$VIA" ] && [ "$VIA" != "$DIRECT" ] || { echo "tailscale: egress NOT going through the exit node" >&2; exit 1; }
