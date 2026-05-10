#!/usr/bin/env bash
# 8gent AX bridge build script.
#
# Builds packages/eyes/native/swift/ with Swift PM in release mode and
# installs the resulting binary to ~/.8gent/bin/8gent-ax-bridge so the
# TS adapter (packages/eyes/backends/ax-native.ts) can spawn it.
#
# Requirements:
#   - macOS 13 or later
#   - Xcode Command Line Tools (xcode-select --install) OR full Xcode 15+
#   - Swift 6 toolchain (ships with Xcode 16)
#
# Usage:
#   bash packages/eyes/native/build.sh           # build + install
#   bash packages/eyes/native/build.sh --check   # exit 0 if already built

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWIFT_DIR="$SCRIPT_DIR/swift"
INSTALL_DIR="${EIGHT_BIN_DIR:-$HOME/.8gent/bin}"
INSTALL_PATH="$INSTALL_DIR/8gent-ax-bridge"

if [[ "${1:-}" == "--check" ]]; then
  if [[ -x "$INSTALL_PATH" ]]; then
    exit 0
  fi
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "8gent-ax-bridge: only supported on macOS (current OS: $(uname -s))" >&2
  exit 1
fi

if ! command -v swift >/dev/null 2>&1; then
  echo "8gent-ax-bridge: 'swift' not on PATH. Install Xcode Command Line Tools: xcode-select --install" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"

cd "$SWIFT_DIR"
echo "8gent-ax-bridge: building (this may take a minute on first run)..." >&2
swift build -c release --product eight-ax-bridge >&2 || swift build -c release >&2

BUILT_BIN="$SWIFT_DIR/.build/release/EightAxBridge"
if [[ ! -x "$BUILT_BIN" ]]; then
  # Swift PM may name the binary after the executable target.
  if [[ -x "$SWIFT_DIR/.build/release/eight-ax-bridge" ]]; then
    BUILT_BIN="$SWIFT_DIR/.build/release/eight-ax-bridge"
  else
    echo "8gent-ax-bridge: build succeeded but binary not found in .build/release/" >&2
    ls -la "$SWIFT_DIR/.build/release/" >&2 || true
    exit 1
  fi
fi

cp "$BUILT_BIN" "$INSTALL_PATH"
chmod +x "$INSTALL_PATH"
echo "8gent-ax-bridge: installed to $INSTALL_PATH" >&2

# Smoke test.
"$INSTALL_PATH" --version >/dev/null 2>&1 || {
  echo "8gent-ax-bridge: installed binary did not respond to --version" >&2
  exit 1
}
echo "8gent-ax-bridge: ready" >&2
