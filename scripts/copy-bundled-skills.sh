#!/usr/bin/env bash
# Copy packages/skills/*/SKILL.md into dist/skills/ for the published CLI bundle.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/dist/skills"
for d in "$ROOT/packages/skills"/*/; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  if [[ -f "${d}SKILL.md" ]]; then
    mkdir -p "$ROOT/dist/skills/$name"
    cp "${d}SKILL.md" "$ROOT/dist/skills/$name/SKILL.md"
  fi
done
