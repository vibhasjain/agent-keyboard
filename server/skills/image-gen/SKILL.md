---
name: image-gen
description: Generate or edit images with Google Gemini and place them in the site repo. Use when the owner asks to generate, create, or illustrate an image, icon, hero graphic, or artwork for the site.
---

# image-gen

Generate images with Gemini and drop them into the site checkout. Requires the
`GEMINI_API_KEY` environment variable — it is already in your environment on
deployments that configured it (it is a Fly secret; it never lives in this
repo). If it is unset, say so plainly: "Image generation isn't configured on
this deployment — the owner needs to set the GEMINI_API_KEY secret."

## How

```bash
node ~/.claude/skills/image-gen/generate.mjs "<prompt>" <output.png> [input-image ...]
```

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
