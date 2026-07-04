---
name: verify-in-browser
description: Visually verify an edit by serving the site checkout locally, screenshotting it with the preinstalled headless Chromium, and reading the screenshot. Use after visual changes (layout, color, images) or when the owner asks you to check how something looks.
---

# verify-in-browser

Playwright + a headless Chromium shell are preinstalled in this image
(`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`). The pattern:

```bash
# 1. serve the checkout (from the repo root — your cwd)
python3 -m http.server 4173 &
SERVER_PID=$!

# 2. screenshot the page you changed (mobile-ish viewport; adjust as needed)
npx playwright screenshot --viewport-size=390,844 --full-page \
  "http://localhost:4173/index.html" /tmp/verify.png

# 3. ALWAYS stop the server
kill $SERVER_PID
```

Then use the Read tool on `/tmp/verify.png` to inspect the render, and describe
what you saw in your reply ("verified — the hero is amber now").

Rules:

- **Always kill the server** and never leave background processes running —
  RAM on this machine is shared with other jobs.
- Screenshots go to `/tmp`, never into the repo (don't commit them).
- Static sites only need `http.server`; if the site has a build step, build
  first (check the repo's README) and serve the build output directory.
- A desktop check uses `--viewport-size=1280,800`.
