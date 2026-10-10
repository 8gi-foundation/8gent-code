#!/usr/bin/env bash
# release-guard.sh - a GitHub release is never published with zero assets (#3326).
#
# release.yml creates the release as a DRAFT with its files attached, then
# calls `publish`, which flips it to published only when the release on GitHub
# actually carries at least the expected number of assets. On failure the
# release stays a draft and the job fails loudly. A draft is never "latest".
# 61 of 63 published releases (to v0.19.0, 9 Oct 2026) carry zero assets.
#
#   release-guard.sh pack <dir>             npm pack into <dir>, then stage it.
#                                           CI runs this on every PR (dry run),
#                                           release.yml runs it on the tag.
#   release-guard.sh stage <dir>            fail if <dir> has no non-empty file;
#                                           write <dir>/SHA256SUMS; print file count
#   release-guard.sh publish <tag> [min]    fail unless the release has >= min
#                                           assets (default 1); then publish it
#   release-guard.sh selftest               prove both guards locally, no network
#
# GH overrides the gh binary (the selftest uses a fake). publish needs GH_TOKEN.

set -euo pipefail

GH="${GH:-gh}"

die() { echo "::error::release-guard: $*" >&2; exit 1; }

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

stage() {
	local dir="${1:-}"
	[[ -n "$dir" && -d "$dir" ]] || die "staging dir '${dir}' does not exist"
	local files=()
	local f
	while IFS= read -r f; do files+=("$f"); done < <(
		cd "$dir" && find . -maxdepth 1 -type f -size +0c ! -name SHA256SUMS | sed 's|^\./||' | LC_ALL=C sort
	)
	[[ ${#files[@]} -gt 0 ]] || die "staging dir '${dir}' has no non-empty files; refusing to release"
	(cd "$dir" && sha256 "${files[@]}" > SHA256SUMS)
	echo "$(( ${#files[@]} + 1 ))"
}

pack() {
	local dir="${1:-}"
	[[ -n "$dir" ]] || die "pack needs a staging dir"
	mkdir -p "$dir"
	npm pack --pack-destination "$dir" --silent >/dev/null || die "npm pack failed"
	ls "$dir"/*.tgz >/dev/null 2>&1 || die "npm pack wrote no tarball to '${dir}'"
	stage "$dir"
}

publish() {
	local tag="${1:-}" min="${2:-1}"
	[[ -n "$tag" ]] || die "publish needs a tag"
	# Canonical base-10 integers only: a leading zero (08) would make bash
	# arithmetic read octal and error out, and an error must never publish.
	[[ "$min" =~ ^(0|[1-9][0-9]*)$ ]] || die "min asset count must be a plain integer >= 1, got '${min}'"
	(( 10#$min >= 1 )) || die "min asset count must be >= 1, got '${min}'"
	local count
	count="$("$GH" release view "$tag" --json assets --jq '[.assets[] | select(.state == "uploaded" and .size > 0)] | length')" \
		|| die "could not read release ${tag}"
	[[ "$count" =~ ^(0|[1-9][0-9]*)$ ]] || die "unexpected asset count '${count}' for ${tag}"
	# Fail closed: publish only on a successful >= test. A false result or an
	# arithmetic error both land in die.
	if ! (( 10#$count >= 10#$min )); then
		die "release ${tag} has ${count} uploaded asset(s), expected >= ${min}; left as draft, not published"
	fi
	"$GH" release edit "$tag" --draft=false >/dev/null || die "could not publish ${tag}"
	echo "release-guard: published ${tag} with ${count} asset(s)"
}

selftest() {
	local tmp pass=0 fail=0
	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' RETURN
	local self="${BASH_SOURCE[0]}"

	ok()  { echo "  ok   $1"; pass=$((pass + 1)); }
	bad() { echo "  FAIL $1"; fail=$((fail + 1)); }
	expect_fail() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then bad "$name"; else ok "$name"; fi; }
	expect_pass() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }

	# Fake gh: reports FAKE_COUNT assets, records every edit call.
	cat > "$tmp/gh" <<'EOF'
#!/usr/bin/env bash
case "$1 $2" in
  "release view") [[ -z "${FAKE_VIEW_FAIL:-}" ]] || exit 1; echo "${FAKE_COUNT}" ;;
  "release edit") echo "$*" >> "${FAKE_LOG}" ;;
  *) exit 2 ;;
esac
EOF
	chmod +x "$tmp/gh"
	export FAKE_LOG="$tmp/edits.log"

	echo "release-guard selftest"
	expect_fail "stage: missing dir fails" bash "$self" stage "$tmp/nope"
	mkdir "$tmp/empty"
	expect_fail "stage: empty dir fails" bash "$self" stage "$tmp/empty"
	mkdir "$tmp/zero" && : > "$tmp/zero/empty.tgz"
	expect_fail "stage: dir with only a zero-byte file fails" bash "$self" stage "$tmp/zero"
	mkdir "$tmp/good" && echo tarball > "$tmp/good/pkg-1.0.0.tgz"
	local n
	n="$(bash "$self" stage "$tmp/good" 2>/dev/null || true)"
	if [[ "$n" == "2" ]] && grep -q 'pkg-1.0.0.tgz' "$tmp/good/SHA256SUMS"; then
		ok "stage: one file -> SHA256SUMS written, count 2"
	else
		bad "stage: one file -> SHA256SUMS written, count 2 (got '${n}')"
	fi

	: > "$FAKE_LOG"
	expect_fail "publish: zero assets fails" env GH="$tmp/gh" FAKE_COUNT=0 bash "$self" publish v9.9.9
	if [[ -s "$FAKE_LOG" ]]; then bad "publish: zero assets never calls edit"; else ok "publish: zero assets never calls edit"; fi
	expect_fail "publish: fewer than min fails" env GH="$tmp/gh" FAKE_COUNT=1 bash "$self" publish v9.9.9 2
	if [[ -s "$FAKE_LOG" ]]; then bad "publish: short upload never calls edit"; else ok "publish: short upload never calls edit"; fi
	expect_fail "publish: garbage count fails" env GH="$tmp/gh" FAKE_COUNT=oops bash "$self" publish v9.9.9
	expect_fail "publish: min 0 is rejected" env GH="$tmp/gh" FAKE_COUNT=0 bash "$self" publish v9.9.9 0
	: > "$FAKE_LOG"
	expect_fail "publish: leading-zero count 08 with min 9 fails" env GH="$tmp/gh" FAKE_COUNT=08 bash "$self" publish v9.9.9 9
	if [[ -s "$FAKE_LOG" ]]; then bad "publish: leading-zero count 08 never calls edit"; else ok "publish: leading-zero count 08 never calls edit"; fi
	expect_fail "publish: leading-zero count 09 is rejected" env GH="$tmp/gh" FAKE_COUNT=09 bash "$self" publish v9.9.9 2
	if [[ -s "$FAKE_LOG" ]]; then bad "publish: leading-zero count 09 never calls edit"; else ok "publish: leading-zero count 09 never calls edit"; fi
	expect_fail "publish: leading-zero min 08 is rejected" env GH="$tmp/gh" FAKE_COUNT=9 bash "$self" publish v9.9.9 08
	expect_fail "publish: gh view failure fails" env GH="$tmp/gh" FAKE_COUNT=9 FAKE_VIEW_FAIL=1 bash "$self" publish v9.9.9
	if [[ -s "$FAKE_LOG" ]]; then bad "publish: rejected inputs never call edit"; else ok "publish: rejected inputs never call edit"; fi
	expect_pass "publish: enough assets passes" env GH="$tmp/gh" FAKE_COUNT=2 bash "$self" publish v9.9.9 2
	if grep -q -- 'release edit v9.9.9 --draft=false' "$FAKE_LOG"; then ok "publish: flips draft=false"; else bad "publish: flips draft=false"; fi

	echo "release-guard selftest: ${pass} passed, ${fail} failed"
	[[ $fail -eq 0 ]]
}

case "${1:-}" in
	pack)     shift; pack "$@" ;;
	stage)    shift; stage "$@" ;;
	publish)  shift; publish "$@" ;;
	selftest) selftest ;;
	*) echo "usage: $0 pack <dir> | stage <dir> | publish <tag> [min] | selftest" >&2; exit 2 ;;
esac
