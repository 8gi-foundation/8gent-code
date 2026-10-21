#!/usr/bin/env bash
# Runs INSIDE the termux/termux-docker container (Termux's own bionic userland,
# arm64). release-binaries.yml's smoke-termux job mounts the checkout at /w and
# the release tarball at /in, then runs this (#4666).
#
#   bash /w/scripts/smoke-termux.sh /in/<package>.tgz vX.Y.Z
#
# Proves what a Termux user hits: the tarball installs with install scripts ON
# (a dependency that fails its install script on bionic, #4658, is red here),
# `8gent --version` names the tag, the TUI draws its first prompt (the
# boot-trace marker, #4541; a render crash like #4660 never reaches it), and
# scripts/install.sh decides about Android instead of crashing.
set -eu

TGZ="${1:?usage: smoke-termux.sh <package.tgz> <vX.Y.Z>}"
TAG="${2:?usage: smoke-termux.sh <package.tgz> <vX.Y.Z>}"
SECONDS_TUI="${TUI_SECONDS:-90}"
fail=0
pass() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; fail=1; }

echo "== userland: $(uname -srm), PREFIX=${PREFIX:-unset}"
apt-get update -y >/dev/null 2>&1 || pkg update -y >/dev/null 2>&1 || true
pkg install -y nodejs util-linux curl >/dev/null
node --version

echo "== npm i -g (install scripts on)"
if npm i -g "$TGZ"; then pass "npm i -g installed the tarball"; else bad "npm i -g failed on Termux"; exit 1; fi

echo "== 8gent --version"
v="$(8gent --version 2>&1 || true)"
echo "$v"
want="${TAG#v}"
case "$v" in *"8gent Code v${want}"*) pass "reports v${want}" ;; *) bad "expected 8gent Code v${want}"; exit 1 ;; esac

echo "== TUI first prompt (boot trace marker, ${SECONDS_TUI}s)"
LOG="$HOME/.8gent/logs/tui-boot.log"
rm -f "$LOG"
OUT="$(mktemp)"
# script gives the TUI a pty; the held-open pipe keeps stdin from closing.
( sleep "$((SECONDS_TUI + 10))" | script -qec "8gent tui --no-pet" /dev/null >"$OUT" 2>&1 ) &
runner=$!
i=0
while [ "$i" -lt "$SECONDS_TUI" ]; do
	grep -qs "first-prompt-render" "$LOG" && break
	grep -qE "TUI entry not found|Could not start the TUI|TypeError|ReferenceError|Error \[" "$OUT" && break
	sleep 1; i=$((i + 1))
done
if grep -qs "first-prompt-render" "$LOG"; then
	pass "TUI reached first-prompt-render in ${i}s"
else
	bad "TUI never reached first-prompt-render within ${SECONDS_TUI}s"
	echo "-- boot trace:"; cat "$LOG" 2>/dev/null || echo "(none)"
	echo "-- last output:"; tail -c 1500 "$OUT" | sed 's/\x1b\[[0-9;?]*[ -\/]*[@-~]//g'
fi
pkill -P "$runner" 2>/dev/null || true
pkill -f "8gent-run.js" 2>/dev/null || true
kill "$runner" 2>/dev/null || true

echo "== install.sh --dry-run on Android"
d="$(sh /w/scripts/install.sh --dry-run 2>&1 || true)"
echo "$d"
if echo "$d" | grep -qE "android +: yes"; then pass "install.sh detected Android/Termux"; else bad "install.sh did not detect Android"; fi
if echo "$d" | grep -qE "a real run would stop here|glibc-runner|Dry run: nothing downloaded"; then pass "install.sh made an Android decision"; else bad "install.sh gave no Android decision"; fi

exit "$fail"
