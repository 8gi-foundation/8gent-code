#!/bin/sh
# Preflight the optional native dependency before the suite runs (#4143).
#
# First drafted by Artale on the forge (artale/8gent-code#25). Adjusted here
# so it can gate CI: it loads the module instead of checking for its folder,
# and it exits non-zero when the load fails.
#
# Why: node-pty is an optionalDependency (#3256). It compiles from source on
# Linux, and `bun install` prints "+ node-pty@1.1.0" even when that build
# failed, so the folder exists while require() throws. CI run 38331907509 hit
# exactly that: install looked clean, then five pty-session tests failed with
# "Expected: 0, Received: 66", the bridge's code for "node-pty is not
# installed" (packages/terminal-tab/pty-bridge.cjs). This check names the
# missing module in its own step, before the suite starts.
#
# The Node it checks is picked in packages/terminal-tab/find-node.ts's order:
# NODE_8GENT_BIN, then the newest executable managed runtime under
# ~/.8gent/runtime, then node on PATH. find-node.ts's step 3
# (process.execPath when it is a node) is skipped: a shell cannot reproduce it.
#
# POSIX sh, no network. Exit 0 when node-pty loads, 1 when it does not.
set -u

cd "$(dirname "$0")/.." || exit 1

fail() {
	echo "preflight: node-pty cannot be loaded under $1: $2" >&2
	cat >&2 <<'EOF'

node-pty is an optionalDependency: an install that could not build it fails
quietly, and terminal tabs (and the pty-session tests) then cannot run.

  fix:  sudo apt install python3 make g++      (Debian or Ubuntu)
        rm -rf node_modules/node-pty && bun install
  on CI: check `node-gyp --version` is on PATH before bun install
EOF
	exit 1
}

# The error line is the reason; bun's source excerpt and the stack add nothing.
check() {
	runtime=$1
	out=$("$runtime" -e "require('node-pty')" 2>&1) && return 0
	reason=$(printf '%s\n' "$out" | grep -E '^[[:space:]]*([A-Za-z]*Error|error):' | head -n 1)
	[ -n "$reason" ] || reason=$(printf '%s\n' "$out" | head -n 1)
	fail "$runtime" "$reason"
}

check bun
# The terminal-tab bridge runs node-pty under Node; load it with the same
# binary the bridge would use. Lowest priority first, each later hit wins.
node=$(command -v node 2>/dev/null)
managed=$(printf '%s\n' "$HOME"/.8gent/runtime/node-*/bin/node | sort -rV | while IFS= read -r n; do
	[ -x "$n" ] && { printf '%s\n' "$n"; break; }
done)
[ -n "$managed" ] && node=$managed
[ -n "${NODE_8GENT_BIN:-}" ] && [ -x "$NODE_8GENT_BIN" ] && node=$NODE_8GENT_BIN

if [ -z "$node" ]; then
	echo "preflight: node-pty loads under bun; node: not found on PATH, not checked"
	exit 0
fi
check "$node"
echo "preflight: node-pty loads under bun and $node"
exit 0
