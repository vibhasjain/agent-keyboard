---
name: tailscale
description: The box's residential egress — a Tailscale exit node (the owner's office iPad) reachable as a local SOCKS5/HTTP proxy. Use when the owner says "use Tailscale", when any site returns 403/429/captcha/"possible spam"/redirect loops from the direct IP, and by default for every real-site browser session.
---

# tailscale — residential egress for browsers

This machine's direct IP is a Fly datacenter address (`hosting=true`); LinkedIn, Ashby, Greenhouse
and others score it as bot traffic. The server runs a dedicated userspace `tailscaled` at boot,
joined to the owner's tailnet and pinned to the owner's office iPad as **exit node**, so traffic
sent through it leaves from a residential Verizon IP. You don't join, log in, or configure
anything — it is already up. Everything you need:

| What | Value |
|---|---|
| SOCKS5 proxy | `socks5://127.0.0.1:1055` (use `--socks5-hostname` in curl; Playwright `proxy: { server: 'socks5://127.0.0.1:1055' }`) |
| HTTP proxy | `http://127.0.0.1:1056` |
| Exit node | `ipad-pro-12-9-6th-gen-wifi` = `$TS_EXIT_NODE` (a Tailscale IP) |
| Control socket | `/data/tailscale-linkedin/tailscaled.sock` (`tailscale --socket=… status`) |
| Daemon log | `/data/tailscale-linkedin/tailscaled.log` |
| Supervisor | `sh /app/tailscale-up.sh` — idempotent; restarts a dead daemon, re-pins the exit node (`TS_AUTHKEY` is a server secret, only needed for a first join, already done) |

## Default policy (owner, 2026-09-04)
1. **Every browser session against a real site goes through the tunnel by default** — LinkedIn,
   ATS boards (Greenhouse/Ashby/Lever/Workable/Workday/iCIMS), anything that scores IPs. Local
   pages (`localhost`, the checkout's own preview) stay direct.
2. **Fail closed.** Before launching, verify the egress:
   `curl -s --max-time 20 --socks5-hostname 127.0.0.1:1055 https://api.ipify.org` must return the
   residential IP (sites keep it as `expectedExitIp` in `cloud/egress.json`; if you have no
   config, compare it against the direct IP `curl -s https://api.ipify.org` — they must differ and
   `sh cloud/ip-check.sh socks5://127.0.0.1:1055` style scoring must say `hosting=false`).
   Not green → do not fall back to the direct IP silently; run the supervisor once, re-check, and
   if still red report "tunnel down" and stop the browser work.
3. **On any IP-shaped failure from a direct request** — 403/406/429, captcha or hCaptcha at
   submit, "possible spam", `ERR_TOO_MANY_REDIRECTS`, an authwall/checkpoint — the next attempt
   goes through the tunnel. Don't retry the direct path.
4. **Never diagnose by reloading.** A rate-limit (429) is per session; hammering burns the
   session. One signal → stop, record, report.
5. **Sessions are born in the browser that uses them.** Log in inside a persistent profile on
   `/data` through the tunnel; never copy cookie jars between browsers or machines.

## Snippets
```js
// Playwright / patchright launch through the tunnel (add the CDP port so the bar's live view works)
const args = process.env.AK_CDP_PORT ? ['--remote-debugging-port=' + process.env.AK_CDP_PORT] : [];
const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false, proxy: { server: 'socks5://127.0.0.1:1055' }, args, viewport: { width: 1280, height: 900 },
});
```
```sh
# health
tailscale --socket=/data/tailscale-linkedin/tailscaled.sock status | head -3
curl -s --socks5-hostname 127.0.0.1:1055 https://api.ipify.org; echo   # residential IP
curl -s https://api.ipify.org; echo                                     # direct (datacenter) IP
```
Only browsers/curl that opt in use the tunnel; the Claude API, git, Supabase and everything else
stay direct. Bandwidth through the iPad is fine for browsing and form submits; don't bulk-download
through it.
