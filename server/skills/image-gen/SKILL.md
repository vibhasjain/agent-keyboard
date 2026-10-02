---
name: image-gen
description: Generate or edit images with Codex's built-in image tool and place them in the site repo. Use when the owner asks to generate, create, or illustrate an image, icon, hero graphic, or artwork for the site.
---

# image-gen

Generate images with Codex's built-in image tool (billed to the box's ChatGPT
subscription — no API key) and drop them into the site checkout. If the helper
fails, run `codex login status`; if it isn't "Logged in using ChatGPT", say
plainly: "Image generation isn't available — Codex on this deployment isn't
logged in to ChatGPT."

## How

```bash
sh ~/.claude/skills/image-gen/generate.sh "<prompt>" <output.png> [input-image ...]
```

Takes ~1 minute per image.

- `<prompt>` — what to generate. Optional input images (paths) are sent along
  for editing/variation.
- `<output.png>` — where the PNG lands. Generate to a neutral temp name first
  (e.g. `/tmp/gen-<random>.png`), then move/rename it into the repo.

After generating: move the image into the repo, reference it from the page,
compress if large (a hero image should be < 300 KB — use `python3` + whatever
is available, or request smaller dimensions in the prompt), commit, push.

## Privacy rules (always apply)

The API provider can see request content. Treat every call as semi-public:

1. **Strip identifying context from prompts.** No names, domains, brand or
   project names, or recognizable proper nouns. Describe the *visual content
   only*: "minimalist illustrated bowl of greens, flat design, white
   background" — not "hero image for <the site>".
2. **Generate to a neutral temp filename** (random id), then rename into the
   repo after generation.
