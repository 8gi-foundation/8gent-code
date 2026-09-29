#!/usr/bin/env bash
# Smoke-test a compiled 8gent binary (bun build --compile output).
# Source-mode tests cannot see this class of bug: anything read from disk or
# loaded as a native addon at import time works under `bun run` and crashes
# inside the compiled binary. Each check runs the real command in a throwaway HOME.
#
#   scripts/smoke-compiled.sh dist/bin/8gent-darwin-arm64
set -uo pipefail

BIN="${1:?usage: smoke-compiled.sh <path-to-compiled-8gent>}"
[ -x "$BIN" ] || { echo "not executable: $BIN" >&2; exit 2; }
BIN="$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")"

TMP_HOME="$(mktemp -d)"
trap 'rm -rf "$TMP_HOME"' EXIT
cd "$TMP_HOME" || exit 2

# macOS has no coreutils timeout; perl alarm works on both macOS and Linux.
run() { local secs="$1"; shift; HOME="$TMP_HOME" perl -e 'alarm shift; exec @ARGV' "$secs" "$@"; }

fail=0
check() {
	local name="$1" expect="$2" out="$3"
	if printf '%s' "$out" | grep -q -- "$expect"; then
		echo "PASS  $name"
	else
		echo "FAIL  $name"
		printf '%s\n' "$out" | tail -5 | sed 's/^/      /'
		fail=1
	fi
}

check "--version" "8gent Code v" "$(run 20 "$BIN" --version 2>&1)"
check "memory remember" "Remembered" "$(run 30 "$BIN" memory remember "smoke-check-marker" 2>&1)"
check "memory recall" "smoke-check-marker" "$(run 30 "$BIN" memory recall smoke-check 2>&1)"
check "rpc answers JSON-RPC" '"jsonrpc":"2.0"' \
	"$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"__smoke__"}' | run 30 "$BIN" rpc 2>&1)"
check "mcp-server initialize" '"serverInfo"' \
	"$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' | run 30 "$BIN" mcp-server 2>&1)"

exit "$fail"
