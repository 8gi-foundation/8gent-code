#!/usr/bin/env bash
# Run the unit suite as N separate `bun test` processes (#3814, #3820).
#
# Bun 1.4.x segfaults on windows-latest roughly ten minutes into one process
# that runs all ~500 test files, which loses every result after that point.
# Shorter processes finish before it. Same files as `bun run test`
# (packages/ apps/ plus the temp-dir guard test), split round-robin so the
# heavy packages spread out. Every shard runs even if an earlier one fails;
# the exit code is non-zero if any shard failed.
#
#   scripts/test-sharded.sh [N]     (default 4)
set -uo pipefail
n="${1:-4}"
cd "$(dirname "$0")/.."

# bun's default test file patterns, under the same roots as the package.json test script.
files=()
while IFS= read -r f; do files+=("$f"); done < <(
	git ls-files 'packages/*' 'apps/*' | grep -E '\.(test|spec)\.[cm]?[jt]sx?$|_(test|spec)\.[cm]?[jt]sx?$' | sort
)
files+=("tests/preload-temp-dirs.test.ts")
echo "test-sharded: ${#files[@]} files in $n shards"

rc=0
for ((s = 0; s < n; s++)); do
	shard=()
	for ((i = s; i < ${#files[@]}; i += n)); do shard+=("./${files[$i]}"); done
	echo "::group::shard $((s + 1))/$n (${#shard[@]} files)"
	bun --no-install test "${shard[@]}" || { echo "shard $((s + 1)) failed"; rc=1; }
	echo "::endgroup::"
done
exit $rc
