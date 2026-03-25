#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

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

# package.json \"tui\" script runs \"bun run ...\" in a child shell; that needs bun on PATH
export PATH="${BUN_BIN}:${PATH}"

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies..."
  "${BUN[@]}" install
fi

exec "${BUN[@]}" run tui
