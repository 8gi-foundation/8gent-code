#!/usr/bin/env bash
# Runs inside the linux-ci image (see Dockerfile). Used by
# .github/workflows/linux-docker.yml and for local reproduction:
#
#   docker build -t 8gent-linux-ci:local .github/docker/linux-ci
#   docker run --rm --init --cpus 6 --memory 6g \
#     -v "$PWD":/src:ro 8gent-linux-ci:local bash /src/.github/docker/linux-ci/run.sh
#
# The checkout is mounted READ-ONLY at /src and copied into the container's
# own filesystem at /work, without node_modules or dist. Install, test and
# build all happen in /work, so the host's node_modules, dist and git state
# are never touched, and the container's Linux node_modules never leak out.
#
# Stages: install, typecheck (baseline-gated), test, build. Every stage after
# install runs even if an earlier one failed, so one run reports everything.
# Exit is non-zero if any stage failed.
set -uo pipefail

SRC=/src
WORK=/work
BASELINE="$SRC/.github/docker/linux-ci/typecheck-baseline.txt"
# CI is set, as on any CI runner. Ink's CI mode (its is-in-ci check writes
# only the final frame) used to break the Ink render tests, so this script
# unset CI. The test preload tests/preload-ink-interactive.ts (wired in
# bunfig.toml) now pins Ink's CI detection off inside bun test, so those tests
# pass either way, and this job proves it. `docker run` does not inherit the
# runner's CI=true, so this is explicit.
export CI=true

echo "== environment"
id
echo "bun $(bun --version) | node $(node --version) | $(rg --version | head -1) | $(git --version)"
uname -srm

echo "== copy /src -> /work (no node_modules, dist, .git)"
tar -C "$SRC" --exclude=node_modules --exclude=./dist --exclude=./.git -cf - . | tar -C "$WORK" -xf -
cd "$WORK"
# Some tests read git state. A CI checkout has a real .git; a local git
# worktree has a .git FILE pointing at a host path that does not exist here.
# Either way, give the copy a self-contained one-commit repo.
git init -q -b main . \
  && git -c user.name=ci -c user.email=ci@localhost add -A \
  && git -c user.name=ci -c user.email=ci@localhost commit -qm "linux-ci snapshot" --no-verify \
  || { echo "::error::git snapshot failed"; exit 1; }

declare -A RESULT

echo "== install"
if bun install --frozen-lockfile; then RESULT[install]=pass; else
  echo "::error::bun install failed"; RESULT[install]=FAIL
  echo "install=FAIL"; exit 1
fi

echo "== typecheck (baseline-gated)"
# main carries known tsc errors, listed in typecheck-baseline.txt as
# "path: TSxxxx" (line numbers dropped so unrelated edits do not churn it).
# The stage fails on any error NOT in the baseline. Fixed baseline errors are
# reported so the baseline can shrink.
bunx tsc --noEmit > /tmp/tsc.out 2>&1
TSC_EXIT=$?
cat /tmp/tsc.out
grep -oE '^[^(]+\([0-9]+,[0-9]+\): error TS[0-9]+' /tmp/tsc.out \
  | sed -E 's/\([0-9]+,[0-9]+\): error /: /' | sort > /tmp/tsc.now
grep -vE '^\s*(#|$)' "$BASELINE" | sort > /tmp/tsc.base
NEW=$(comm -23 /tmp/tsc.now /tmp/tsc.base)
GONE=$(comm -13 <(sort -u /tmp/tsc.now) <(sort -u /tmp/tsc.base))
echo "tsc exit=$TSC_EXIT, errors=$(wc -l < /tmp/tsc.now), baseline=$(wc -l < /tmp/tsc.base)"
if [ -n "$GONE" ]; then echo "Baseline errors now fixed (remove from typecheck-baseline.txt):"; echo "$GONE"; fi
if [ -n "$NEW" ]; then
  echo "::error::typecheck: errors not in the baseline:"; echo "$NEW"; RESULT[typecheck]=FAIL
elif [ "$TSC_EXIT" -ne 0 ] && [ ! -s /tmp/tsc.now ]; then
  echo "::error::tsc failed without reporting TS errors"; RESULT[typecheck]=FAIL
else
  RESULT[typecheck]=pass
fi

echo "== test"
# A private session bus with a throwaway, unlocked keyring, so the Linux
# Secret Service tests exercise secret-tool for real.
if dbus-run-session -- bash -c 'printf ci | gnome-keyring-daemon --unlock --components=secrets >/dev/null 2>&1; bun run test'; then RESULT[test]=pass; else echo "::error::bun run test failed"; RESULT[test]=FAIL; fi

echo "== build"
if bun run build && test -f dist/cli.js && head -1 dist/cli.js | grep -q '^#!/usr/bin/env bun'; then
  echo "Build OK: $(wc -c < dist/cli.js | tr -d ' ') bytes"; RESULT[build]=pass
else
  echo "::error::build failed"; RESULT[build]=FAIL
fi

echo "== summary"
STATUS=0
for s in install typecheck test build; do
  echo "$s=${RESULT[$s]}"
  [ "${RESULT[$s]}" = pass ] || STATUS=1
done
exit $STATUS
