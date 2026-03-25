#!/usr/bin/env bash
# Lil Eight terminal pet (Linux, Windows WSL, any Unix with Bun + terminal)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"

if command -v bun >/dev/null 2>&1; then
  BUN_EXE="$(command -v bun)"
  BUN_BIN="$(cd "$(dirname "$BUN_EXE")" && pwd)"
  BUN=("$BUN_EXE")
elif [[ -x "${HOME}/.bun/bin/bun" ]]; then
  BUN_BIN="${HOME}/.bun/bin"
  BUN=("${BUN_BIN}/bun")
else
  echo "bun not found. Install: https://bun.sh" >&2
  exit 1
fi

export PATH="${BUN_BIN}:${PATH}"
cd "$REPO"
exec "${BUN[@]}" run packages/pet/terminal-pet.ts
