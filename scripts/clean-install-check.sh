#!/bin/sh
# Clean-container install check for a PUBLISHED release (#3743).
#
# bare-install-smoke.sh checks a tarball packed from a checkout. This checks
# what a stranger actually gets: the version on npm, or the tarball on the
# GitHub release page, installed into a plain node:22 container that has no
# repo checkout, no Bun and a fresh HOME. Two releases (v0.18.1, v0.19.0)
# shipped with no assets and nobody noticed (#3326); this is the alarm.
#
#   sh scripts/clean-install-check.sh latest          # whatever npm latest is
#   sh scripts/clean-install-check.sh 0.17.0          # npm, release tarball if npm lags
#   sh scripts/clean-install-check.sh v0.18.0         # same; a leading v is dropped
#   sh scripts/clean-install-check.sh ./pkg.tgz       # a local tarball
#   sh scripts/clean-install-check.sh https://.../8gi-foundation-8gent-code-0.18.0.tgz
#
# Checks, in order (every one must pass):
#   1. the container is clean: no bun, no ~/.8gent
#   2. install: npm install -g @8gi-foundation/8gent-code@<version>, install
#      scripts ON. If npm has no such version, the release tarball
#      v<version>/8gi-foundation-8gent-code-<version>.tgz is downloaded, checked
#      against the release SHA256SUMS, and installed. Neither present = FAIL.
#   3. without Bun, `8gent --version` exits non-zero and says how to get Bun
#   4. npm install -g bun (what 8gent.dev/install.sh does), then
#      `8gent --version` exits 0 and prints "8gent Code v<version>"
#   5. `8gent --help` exits 0 and prints USAGE
#
# Env:
#   CLEAN_INSTALL_IMAGE         image (default node:22). The digest used is printed.
#   CLEAN_INSTALL_NPM_ONLY=1    fail instead of falling back to the release tarball
#
# Needs only sh and Docker on the host. The repo is never mounted; the check
# runs from stdin. A local tarball is mounted read-only at /candidate.tgz.
set -eu

ARG=${1:?usage: clean-install-check.sh <latest|version|tarball path|tarball URL>}
IMAGE=${CLEAN_INSTALL_IMAGE:-node:22}
NPM_ONLY=${CLEAN_INSTALL_NPM_ONLY:-0}
MOUNT=""

case "$ARG" in
  https://*.tgz) MODE=url ;;
  *.tgz)
    [ -f "$ARG" ] || { echo "FAIL  tarball not found: $ARG"; exit 1; }
    MODE=file
    MOUNT="$(cd "$(dirname "$ARG")" && pwd)/$(basename "$ARG"):/candidate.tgz:ro" ;;
  latest) MODE=version ;;
  *)
    MODE=version
    ARG=${ARG#v}
    echo "$ARG" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$' \
      || { echo "FAIL  not a version, .tgz path or https .tgz URL: $ARG"; exit 1; } ;;
esac

docker info >/dev/null 2>&1 || { echo "FAIL  Docker daemon is not reachable"; exit 1; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull -q "$IMAGE" >/dev/null
echo "== clean install: $MODE $ARG in $IMAGE ($(docker image inspect "$IMAGE" --format '{{index .RepoDigests 0}}' 2>/dev/null || echo 'digest unknown'))"

# shellcheck disable=SC2086
exec docker run --rm -i --init \
  ${MOUNT:+-v "$MOUNT"} \
  -e npm_config_update_notifier=false \
  -e npm_config_fund=false \
  -e npm_config_audit=false \
  "$IMAGE" sh -s -- "$MODE" "$ARG" "$NPM_ONLY" <<'INNER'
set -u
MODE=$1 ARG=$2 NPM_ONLY=$3
PKG=@8gi-foundation/8gent-code
REL=https://github.com/8gi-foundation/8gent-code/releases/download
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
finish() {
  if [ $FAIL = 0 ]; then echo "clean-install-check: PASS ${VERSION:-?} via ${CHANNEL:-?}"; else echo "clean-install-check: FAILED ${VERSION:-?} via ${CHANNEL:-?}"; fi
  exit $FAIL
}

# A fresh HOME, as on a stranger's first run.
HOME=$(mktemp -d /tmp/home.XXXXXX); export HOME
cd "$HOME"
echo "node $(node --version), npm $(npm --version), $(uname -m)"

# 1. Clean.
if command -v bun >/dev/null 2>&1 || [ -e "$HOME/.8gent" ]; then
  fail "container is clean (no bun, no ~/.8gent)"; finish
fi
pass "container is clean (no bun, no ~/.8gent)"

# Download a release tarball and verify it against the SHA256SUMS beside it.
fetch_verified() { # $1 = tarball URL
  base=${1%/*}; name=${1##*/}
  curl -fsSL -o "/tmp/$name" "$1" || { fail "download $1"; return 1; }
  if ! curl -fsSL -o /tmp/SHA256SUMS "$base/SHA256SUMS"; then
    fail "release has SHA256SUMS ($base/SHA256SUMS)"; return 1
  fi
  if (cd /tmp && grep " $name\$" SHA256SUMS | sha256sum -c - >/dev/null 2>&1); then
    pass "checksum of $name matches SHA256SUMS"
  else
    fail "checksum of $name matches SHA256SUMS"; return 1
  fi
  TARBALL=/tmp/$name
}

# 2. Install.
TARBALL=""
case "$MODE" in
  version)
    VERSION=$ARG
    if [ "$VERSION" = latest ]; then
      VERSION=$(npm view "$PKG" version 2>/dev/null)
      [ -n "$VERSION" ] || { CHANNEL=npm; fail "npm view $PKG version"; finish; }
      echo "npm latest is $VERSION"
    fi
    if [ "$(npm view "$PKG@$VERSION" version 2>/dev/null)" = "$VERSION" ]; then
      CHANNEL=npm
      SPEC="$PKG@$VERSION"
    elif [ "$NPM_ONLY" = 1 ]; then
      CHANNEL=npm; fail "npm has $PKG@$VERSION (latest is $(npm view "$PKG" version 2>/dev/null))"; finish
    else
      CHANNEL=release-tarball
      echo "NOTE  npm has no $PKG@$VERSION (latest is $(npm view "$PKG" version 2>/dev/null)); trying the v$VERSION release tarball"
      fetch_verified "$REL/v$VERSION/8gi-foundation-8gent-code-$VERSION.tgz" || finish
      SPEC=$TARBALL
    fi ;;
  url)  CHANNEL=url;  fetch_verified "$ARG" || finish; SPEC=$TARBALL ;;
  file) CHANNEL=file; SPEC=/candidate.tgz ;;
esac

if npm install -g "$SPEC" > /tmp/install.log 2>&1; then
  pass "npm install -g $SPEC (install scripts on)"
else
  fail "npm install -g $SPEC (install scripts on)"
  tail -20 /tmp/install.log
  finish
fi
INSTALLED=$(node -p "require('$(npm root -g)/$PKG/package.json').version")
VERSION=${VERSION:-$INSTALLED}
if [ "$INSTALLED" = "$VERSION" ]; then pass "installed package is $INSTALLED"; else fail "installed package is $INSTALLED, expected $VERSION"; fi

# 3. Without Bun the launcher must say what to do, not crash.
OUT=$(8gent --version 2>&1 </dev/null); CODE=$?
if [ $CODE != 0 ] && echo "$OUT" | grep -q "requires Bun"; then
  pass "without Bun, 8gent --version explains how to get Bun (exit $CODE)"
else
  fail "without Bun, 8gent --version explains how to get Bun (exit $CODE: $(echo "$OUT" | head -3))"
fi

# 4. Bun the way install.sh installs it, then the real version.
if npm install -g bun > /tmp/bun.log 2>&1 && command -v bun >/dev/null 2>&1; then
  pass "npm install -g bun ($(bun --version))"
else
  fail "npm install -g bun"; tail -10 /tmp/bun.log; finish
fi
OUT=$(8gent --version 2>&1 </dev/null); CODE=$?
LINE=$(echo "$OUT" | tail -1)
if [ $CODE = 0 ] && [ "$LINE" = "8gent Code v$VERSION" ]; then
  pass "8gent --version ($LINE)"
else
  fail "8gent --version, expected '8gent Code v$VERSION' (exit $CODE: $(echo "$OUT" | tail -3))"
fi

# 5. Help, non-interactive.
OUT=$(8gent --help 2>&1 </dev/null); CODE=$?
if [ $CODE = 0 ] && echo "$OUT" | grep -q "^USAGE"; then
  pass "8gent --help prints USAGE ($(echo "$OUT" | wc -l | tr -d ' ') lines)"
else
  fail "8gent --help prints USAGE (exit $CODE: $(echo "$OUT" | tail -3))"
fi

finish
INNER
