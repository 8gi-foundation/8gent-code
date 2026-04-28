#!/usr/bin/env bash
# Copy apps/tui/sounds/*.mp3 into dist/sounds/ so the published CLI ships
# the launch instrumental + any other bundled audio assets.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/apps/tui/sounds"
DEST="$ROOT/dist/sounds"

if [ ! -d "$SRC" ]; then
  echo "[copy-bundled-sounds] no sounds dir at $SRC, skipping"
  exit 0
fi

mkdir -p "$DEST"
copied=0
for f in "$SRC"/*.mp3 "$SRC"/*.wav; do
  [ -f "$f" ] || continue
  cp "$f" "$DEST/"
  copied=$((copied + 1))
done
echo "[copy-bundled-sounds] copied $copied files to dist/sounds/"
