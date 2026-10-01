#!/bin/sh
# Bare-machine install smoke for the npm package (#3256).
#
# pack-smoke.ts installs with --ignore-scripts on the build machine, so it
# never saw what a stranger sees: on a clean Linux box, `npm install -g` ran
# node-gyp for node-pty and tree-sitter, found no Python, and failed outright.
#
# This installs the packed tarball the way a stranger does - install scripts
# ON, in a clean node:22-bookworm-slim container with no Python and no
# compiler - and checks that:
#   1. npm install -g bun <tarball>        succeeds
#   2. 8gent --version                     prints a version
#   3. dist/pty-bridge.cjs ships, and either opens a pty (node-pty built) or
#      exits 66 with the "Terminal tabs are unavailable" message (skipped)
#   4. 8gent tui --no-pet under a pty      renders its first screen
#
#   sh scripts/bare-install-smoke.sh <path/to/8gi-foundation-8gent-code-X.tgz>
#
# Needs only sh and Docker on the host. Nothing is written outside the
# container except a named npm cache volume (8gent-bare-install-npm-cache),
# which holds downloaded tarballs, never build tools.
set -eu

TARBALL=${1:?usage: bare-install-smoke.sh <tarball>}
[ -f "$TARBALL" ] || { echo "FAIL  tarball not found: $TARBALL"; exit 1; }
TARBALL_ABS=$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")

# node:22-bookworm-slim, pinned by digest (multi-arch index). Bump deliberately:
#   docker pull node:22-bookworm-slim && docker image inspect node:22-bookworm-slim --format '{{index .RepoDigests 0}}'
IMAGE=${BARE_INSTALL_IMAGE:-node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c}

echo "== bare-machine install: $(basename "$TARBALL") in $IMAGE"
exec docker run --rm --init \
  -v "$TARBALL_ABS":/candidate.tgz:ro \
  -v 8gent-bare-install-npm-cache:/root/.npm \
  -e npm_config_update_notifier=false \
  "$IMAGE" sh -c '
set -u
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

if command -v python3 >/dev/null 2>&1 || command -v g++ >/dev/null 2>&1; then
  fail "image is not bare (python3 or g++ present)"
fi

if npm install -g --no-audit --no-fund bun /candidate.tgz > /tmp/install.log 2>&1; then
  pass "npm install -g with install scripts on a bare machine"
else
  fail "npm install -g with install scripts on a bare machine"
  grep -E "gyp ERR! (cwd|stack Error)|npm error (path|code)" /tmp/install.log | head -8
  exit 1
fi

VER=$(8gent --version 2>&1 | tail -1)
case "$VER" in
  *"8gent Code v"*) pass "8gent --version ($VER)" ;;
  *) fail "8gent --version ($VER)" ;;
esac

PKG="$(npm root -g)/@8gi-foundation/8gent-code"
BRIDGE="$PKG/dist/pty-bridge.cjs"
if [ ! -f "$BRIDGE" ]; then
  fail "dist/pty-bridge.cjs ships in the package"
else
  pass "dist/pty-bridge.cjs ships in the package"
  OUT=$(echo "{\"type\":\"kill\"}" | PTY_CWD=/tmp node "$BRIDGE" /bin/sh 2>&1); CODE=$?
  if [ -d "$PKG/node_modules/node-pty" ]; then
    case "$OUT" in *"\"type\":\"ready\""*) pass "node-pty present: bridge opened a pty" ;; *) fail "node-pty present but bridge did not open a pty ($OUT)" ;; esac
  elif [ "$CODE" = 66 ] && echo "$OUT" | grep -q "Terminal tabs are unavailable"; then
    pass "node-pty skipped: terminal tab explains itself and exits 66"
  else
    fail "node-pty skipped but bridge did not degrade cleanly (exit $CODE: $OUT)"
  fi
fi

mkdir -p /tmp/work && cd /tmp/work
printf "stty cols 120 rows 40 2>/dev/null\nexec 8gent tui --no-pet\n" > /tmp/launch.sh
# --foreground keeps the TUI in the pty foreground process group. Without it
# the TUI is a background job on its own terminal and the kernel stops it
# (SIGTTOU) the moment Ink sets raw mode, which looks exactly like a hang.
TERM=xterm-256color script -q -f -e -c "timeout --foreground -s KILL 90 sh /tmp/launch.sh" /tmp/tui.out </dev/null >/dev/null 2>&1 &
screen() { sed "s/$(printf "\033")\[[0-9;?]*[ -\/]*[@-~]//g" /tmp/tui.out 2>/dev/null; }
i=0
while [ $i -lt 120 ]; do
  if screen | grep -aqE "I.m 8gent|8GENT FM"; then break; fi
  sleep 0.5; i=$((i + 1))
done
if screen | grep -aqE "I.m 8gent|8GENT FM"; then
  pass "TUI rendered its first screen"
else
  fail "TUI rendered its first screen"
  screen | tail -c 2000
fi
# The TUI is still running; the container exits with this script and --init
# reaps it. Nothing on the host is signalled.

if [ $FAIL = 0 ]; then echo "bare-install-smoke: all checks passed"; else echo "bare-install-smoke: FAILED"; fi
exit $FAIL
'
