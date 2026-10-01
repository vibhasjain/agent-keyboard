---
name: make-me-pixels
description: Make Make Me Pixels-style pixel art (an animated pixel loop from a photo or an idea) right here in this Agent Keyboard session, visible in the requester's thread. Use whenever someone in this session asks for pixel art, a pixel animation, a "make me pixels" piece, or edits to one (e.g. "make the Agent Keyboard art", "remove the black lines on the monitor"). Never hand the work to the Make Me Pixels site's own Agent Keyboard session.
---

# make-me-pixels (inside the Agent Keyboard session)

The owner's Make Me Pixels Agent Keyboard session (site `makemepixels`) is **his alone**. Art asked for here is made
**here, in this job**, so the requester watches it happen in their own thread and gets the image back in it.

## Never
- Never post into, queue onto or call the API of the `makemepixels` Agent Keyboard session.
- Never edit, commit or run anything inside `/data/checkouts/makemepixels` (the owner's live session works there).
  Reading it to clone is fine.
- Never publish to makemepixels.com (the gallery) unless the owner himself asks. Guests get drafts.

## Do
1. Say what you're doing in one line ("Making a Make Me Pixels loop for you: …") so it shows in the thread.
2. Work in a private side clone, one per requester:
   ```bash
   S=/data/side/mmp-<requester-handle>            # e.g. mmp-xia
   [ -d $S ] || git clone -q /data/checkouts/makemepixels $S
   git -C $S pull -q --ff-only || true
   [ -e $S/node_modules ] || ln -s /data/checkouts/makemepixels/node_modules $S/node_modules
   ```
   Read `$S/CLAUDE.md` ("Making art") and `$S/scripts/` — that is the pipeline. Follow it.
3. Generate with the repo's own pipeline, as a draft (no upload):
   ```bash
   cd $S && node scripts/make-pixels.mjs --dry --action "<what the character does>" --title "<caption>" <photo(s)>
   ```
   Generation is Codex CLI image gen (logged in on this box). Never Gemini, never API keys. "Could not detect frames" =
   bad sheet, run it again. Edits to an existing piece (crop, lines, colours, sizes): work on its frames/sheet in `$S/.tmp/`
   with small node scripts, the way the pipeline does; fix what was asked, don't redesign.
4. Check every frame before you show it (extract frames, look at them).
5. Show it: copy the result (animated WebP, plus a frames sheet PNG if useful) into **this** checkout's
   `.tmp/outputs/` so it appears in the reply. Keep files small.
6. Publish only where the requester asked:
   - **agentkeyboard.com** (this repo's `site/`): add the file under `site/`, update `site/index.html`, commit, push.
     A `site/`-only push deploys the website without restarting the server.
   - **makemepixels.com**: only if the owner (vibhas111@gmail.com) asks; then run without `--dry`.
   - Anywhere else: ask in the thread.
