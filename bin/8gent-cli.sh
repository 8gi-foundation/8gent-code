#!/usr/bin/env bash
# 8gent CLI - The Infinite Gentleman
#
# Routes `8gent run ...` to the headless one-shot runner (stream-json capable,
# designed for Orchestra, cmux, and other terminal hosts). Everything else
# falls through to the Ink TUI experience.
#
# Resolves the repo root from this script's own location so the shim works
# for source installs and `npm link`. Follows one level of symlink so users
# can symlink this into ~/.local/bin without editing paths.
set -e

SELF="${BASH_SOURCE[0]}"
if [ -L "$SELF" ]; then
  SELF="$(readlink "$SELF")"
  # If readlink returned a relative path, resolve against the link's dir.
  case "$SELF" in
    /*) ;;
    *) SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && cd "$(dirname "$SELF")" && pwd)/$(basename "$SELF")" ;;
  esac
fi
BIN_DIR="$(cd "$(dirname "$SELF")" && pwd)"
REPO_ROOT="$(cd "$BIN_DIR/.." && pwd)"

if [ "${1:-}" = "run" ]; then
  shift
  exec bun run "$REPO_ROOT/bin/8gent.ts" run "$@"
fi

exec bun run "$REPO_ROOT/apps/tui/src/index.tsx" "$@"
