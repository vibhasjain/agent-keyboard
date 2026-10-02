#!/bin/sh
# Image generation through Codex's built-in image tool, billed to the box's
# ChatGPT subscription (no API key). Usage:
#   sh generate.sh "<prompt>" <output.png> [input-image ...]
set -eu
[ $# -ge 2 ] || { echo 'usage: sh generate.sh "<prompt>" <output.png> [input-image ...]' >&2; exit 2; }
prompt=$1; out=$2; shift 2
case $out in /*) ;; *) out=$(pwd)/$out ;; esac
mkdir -p "$(dirname "$out")"; rm -f "$out"

imgs=""  # ponytail: input paths with spaces break; temp paths never have them
for f in "$@"; do imgs="$imgs --image=$f"; done

# shellcheck disable=SC2086
codex exec --skip-git-repo-check --ephemeral -s workspace-write -C "$(dirname "$out")" $imgs -- \
  "Use your image generation tool to create this image${imgs:+ (use the attached image(s) as the reference to edit or vary)}: $prompt
Save the final PNG to $out. Reply with only the saved path." </dev/null >/dev/null 2>&1 || true

[ -s "$out" ] || { echo "Image generation failed — codex produced no file (check \`codex login status\`)." >&2; exit 1; }
echo "$out"
