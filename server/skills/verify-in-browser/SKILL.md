---
name: verify-in-browser
description: Visually verify an edit by serving the site checkout locally, screenshotting it with the preinstalled headless Chromium, and reading the screenshot. Use after visual changes (layout, color, images) or when the owner asks you to check how something looks.
---

# verify-in-browser

Playwright + a headless Chromium shell are preinstalled in this image
(`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`). The pattern:

```bash
# 1. serve the checkout (from the repo root — your cwd); the trap guarantees
#    the server dies even if the screenshot command fails
python3 -m http.server 4173 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT

# 2. screenshot the page you changed (mobile-ish viewport; adjust as needed).
#    NODE_PATH exposes the Playwright package installed globally in the image.
AK_PAGE_URL="http://localhost:4173/index.html" AK_SCREENSHOT="/tmp/verify.png" \
NODE_PATH="$(npm root -g)" node <<'NODE'
const { chromium } = require('playwright')
;(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: process.env.AK_CDP_PORT ? ['--remote-debugging-port=' + process.env.AK_CDP_PORT] : [],
  })
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await page.goto(process.env.AK_PAGE_URL, { waitUntil: 'networkidle' })
    await page.screenshot({ path: process.env.AK_SCREENSHOT, fullPage: true })
  } finally {
    await browser.close()
  }
})().catch((error) => { console.error(error); process.exit(1) })
NODE
```

Then use the Read tool on `/tmp/verify.png` to inspect the render, and describe
what you saw in your reply ("verified — the hero is amber now").

Rules:

- **Run the whole block as ONE command** so the trap can do its job — the trap
  kills the server when that shell exits, even if the screenshot fails. Never
  leave background processes running: RAM on this machine is shared with other
  jobs. (Orphaned `http.server`s have leaked before — check with
  `ls /proc/*/exe` if in doubt and kill strays.)
- Screenshots go to `/tmp`, never into the repo (don't commit them).
- Static sites only need `http.server`; if the site has a build step, build
  first (check the repo's README) and serve the build output directory.
- A desktop check uses `--viewport-size=1280,800`.
