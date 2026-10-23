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
# boot-trace marker, #4541; a render crash like #4660 never reaches it; the
# launch-time music and voice questions are answered and each seen once), and
# scripts/install.sh decides about Android instead of crashing. Then the daemon:
# `8gent daemon run` from the installed package starts on Node, GET /health
# answers on its loopback port, a client attaches over the WebSocket and gets the
# session list, and the daemon stops on SIGTERM (#4852).
set -eu

TGZ="${1:?usage: smoke-termux.sh <package.tgz> <vX.Y.Z>}"
TAG="${2:?usage: smoke-termux.sh <package.tgz> <vX.Y.Z>}"
SECONDS_TUI="${TUI_SECONDS:-90}"
fail=0
pass() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; fail=1; }

echo "== userland: $(uname -srm), PREFIX=${PREFIX:-unset}"
apt-get update -y >/dev/null 2>&1 || pkg update -y >/dev/null 2>&1 || true
pkg install -y nodejs util-linux curl termux-exec >/dev/null

# A real Termux shell always runs with LD_PRELOAD=$PREFIX/lib/libtermux-exec*.so
# (termux-exec), which rewrites a /usr/bin/env shebang to $PREFIX/bin/env. A bare
# `docker run ... bash script` does not get it, so npm's bin shims (#!/usr/bin/env
# node) die with "bad interpreter" in the harness while working on a device.
# Give this script the same environment, then re-run it once so every process it
# starts (npm, 8gent, script) is a child of a shell that has the preload.
PFX="${PREFIX:-/data/data/com.termux/files/usr}"
if [ -z "${SMOKE_TERMUX_PRELOADED:-}" ]; then
	preload=""
	# Newest termux-exec first, then the classic name.
	for f in "$PFX"/lib/libtermux-exec-ld-preload.so "$PFX"/lib/libtermux-exec-direct-ld-preload.so \
		"$PFX"/lib/libtermux-exec.so "$PFX"/lib/libtermux-exec*.so; do
		[ -e "$f" ] && { preload="$f"; break; }
	done
	if [ -z "$preload" ]; then
		echo "FAIL  termux-exec installed no libtermux-exec*.so under $PFX/lib (cannot match a real Termux shell)"
		ls -l "$PFX"/lib | grep -i termux || true
		exit 1
	fi
	echo "== LD_PRELOAD=$preload (as a real Termux shell sets it)"
	SMOKE_TERMUX_PRELOADED=1 LD_PRELOAD="$preload" exec bash "$0" "$@"
fi
echo "== active preload: ${LD_PRELOAD:-none}"
case "${LD_PRELOAD:-}" in *libtermux-exec*) ;; *) echo "FAIL  LD_PRELOAD is not termux-exec"; exit 1 ;; esac
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
# script gives the TUI a pty. On a fresh Termux the launch asks two setup questions
# (music tools, then voice input, #4833) and waits for a line on stdin, so a held-open
# silent pipe hangs here. Answer them the way a person would: type "n" once each question
# is on screen. Declining installs nothing; the point is that the offer is made, once.
Q_MUSIC="Set up this phone for music"
Q_MIC="Turn on voice input"
answer_setup() {
	for q in "$Q_MUSIC" "$Q_MIC"; do
		t=0
		until grep -aqs "$q" "$OUT"; do
			sleep 1; t=$((t + 1))
			[ "$t" -gt "$SECONDS_TUI" ] && break
		done
		sleep 1
		echo n
	done
	# Then hold stdin open so the TUI keeps running until we have looked.
	sleep "$((SECONDS_TUI + 10))"
}
( answer_setup | script -qec "8gent tui --no-pet" /dev/null >"$OUT" 2>&1 ) &
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
# The one-yes setup is tested, not skipped: each launch question appeared exactly once.
for q in "$Q_MUSIC" "$Q_MIC"; do
	n="$(grep -ao "$q" "$OUT" | wc -l | tr -d ' ')"
	if [ "$n" = "1" ]; then pass "launch asked \"$q\" once"; else bad "launch asked \"$q\" $n times (want 1)"; fi
done
pkill -P "$runner" 2>/dev/null || true
pkill -f "8gent-run.js" 2>/dev/null || true
kill "$runner" 2>/dev/null || true

echo "== daemon from the installed package (Node, loopback)"
DPORT="${DAEMON_SMOKE_PORT:-18790}"
DLOG="$(mktemp)"
# An answer on the port before we start means /health below would be someone else's daemon.
if curl -fsS "http://127.0.0.1:$DPORT/health" >/dev/null 2>&1; then
	echo "FAIL  something already answers on 127.0.0.1:$DPORT; the daemon check would prove nothing (set DAEMON_SMOKE_PORT)"
	exit 1
fi
EIGHT_DAEMON_PORT="$DPORT" 8gent daemon run >"$DLOG" 2>&1 &
dpid=$!
up=0
i=0
while [ "$i" -lt "${DAEMON_SECONDS:-60}" ]; do
	kill -0 "$dpid" 2>/dev/null || break
	# Only our own process counts: a health answer with our pid gone is not a pass.
	if curl -fsS "http://127.0.0.1:$DPORT/health" >/dev/null 2>&1 && kill -0 "$dpid" 2>/dev/null; then up=1; break; fi
	sleep 1; i=$((i + 1))
done
if [ "$up" = "1" ]; then
	pass "daemon answered GET /health on 127.0.0.1:$DPORT in ${i}s"
	if node /w/scripts/daemon-attach-check.mjs "$DPORT"; then
		pass "a client attached over the WebSocket and listed sessions"
	else
		bad "daemon is up but a client could not attach"
	fi
else
	bad "daemon never answered GET /health on 127.0.0.1:$DPORT (process alive: $(kill -0 "$dpid" 2>/dev/null && echo yes || echo no))"
fi
if kill -0 "$dpid" 2>/dev/null; then
	kill -TERM "$dpid" 2>/dev/null || true
	j=0
	while kill -0 "$dpid" 2>/dev/null && [ "$j" -lt 15 ]; do sleep 1; j=$((j + 1)); done
	if kill -0 "$dpid" 2>/dev/null; then
		kill -KILL "$dpid" 2>/dev/null || true
		bad "daemon ignored SIGTERM for 15s and was killed"
	else
		pass "daemon stopped on SIGTERM in ${j}s"
	fi
elif [ "$up" = "1" ]; then
	bad "daemon exited by itself while it was being checked"
fi
if [ "$fail" != "0" ]; then echo "-- daemon output:"; tail -c 2500 "$DLOG"; fi

echo "== install.sh --dry-run on Android"
d="$(sh /w/scripts/install.sh --dry-run 2>&1 || true)"
echo "$d"
if echo "$d" | grep -qE "android +: yes"; then pass "install.sh detected Android/Termux"; else bad "install.sh did not detect Android"; fi
if echo "$d" | grep -qE "a real run would stop here|glibc-runner|Dry run: nothing downloaded"; then pass "install.sh made an Android decision"; else bad "install.sh gave no Android decision"; fi

exit "$fail"
