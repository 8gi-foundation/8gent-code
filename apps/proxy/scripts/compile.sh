#!/usr/bin/env bash
#
# Compile 8gent-proxy to a single self-contained binary per OS/arch using
# `bun build --compile`. No runtime, no node_modules, no Bun install needed on
# the target machine - just the one file.
#
# Usage:
#   bash scripts/compile.sh                 # all targets
#   bash scripts/compile.sh darwin-arm64    # a single named target
#
# Output lands in apps/proxy/dist/. These binaries are the input to the OS
# packagers (NSIS on Windows, nfpm on Linux) and to code signing.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

ENTRY="src/index.ts"
OUT="dist"
mkdir -p "$OUT"

# target-triple : output-filename
TARGETS=(
	"bun-darwin-arm64:8gent-proxy-darwin-arm64"
	"bun-darwin-x64:8gent-proxy-darwin-x64"
	"bun-linux-x64:8gent-proxy-linux-x64"
	"bun-linux-arm64:8gent-proxy-linux-arm64"
	"bun-windows-x64:8gent-proxy-win-x64.exe"
)

want="${1:-all}"

for pair in "${TARGETS[@]}"; do
	triple="${pair%%:*}"
	outfile="${pair##*:}"
	short="${triple#bun-}"
	if [[ "$want" != "all" && "$want" != "$short" ]]; then
		continue
	fi
	echo "==> compiling $short -> $OUT/$outfile"
	bun build "$ENTRY" --compile --target="$triple" --outfile "$OUT/$outfile"
done

echo "==> done"
ls -lh "$OUT"
