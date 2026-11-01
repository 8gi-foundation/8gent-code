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
#   release-guard.sh publish-complete <tag> <regex>...
#                                           fail unless EVERY regex matches the
#                                           name of an uploaded, non-empty asset;
#                                           then publish. release-binaries.yml uses
#                                           this so a release never goes public
#                                           without its Windows .exe (#3803).
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

publish_complete() {
	local tag="${1:-}"
	[[ -n "$tag" ]] || die "publish-complete needs a tag"
	shift
	[[ $# -gt 0 ]] || die "publish-complete needs at least one asset name pattern"
	local names
	names="$("$GH" release view "$tag" --json assets --jq '.assets[] | select(.state == "uploaded" and .size > 0) | .name')" \
		|| die "could not read release ${tag}"
	local re missing=()
	for re in "$@"; do
		printf '%s\n' "$names" | grep -Eq -- "$re" || missing+=("$re")
	done
	if [[ ${#missing[@]} -gt 0 ]]; then
		die "release ${tag} is missing assets matching: ${missing[*]}; left as draft, not published"
	fi
	# SHA256SUMS must list every required asset (except itself) by exact name.
	local sums name unlisted=()
	sums="$("$GH" release download "$tag" --pattern SHA256SUMS --output -)" \
		|| die "could not read SHA256SUMS on ${tag}"
	while IFS= read -r name; do
		[[ -n "$name" && "$name" != "SHA256SUMS" ]] || continue
		for re in "$@"; do
			if printf '%s\n' "$name" | grep -Eq -- "$re"; then
				printf '%s\n' "$sums" | awk -v n="$name" '$2 == n { f = 1 } END { exit !f }' || unlisted+=("$name")
				break
			fi
		done
	done <<< "$names"
	if [[ ${#unlisted[@]} -gt 0 ]]; then
		die "SHA256SUMS on ${tag} has no line for: ${unlisted[*]}; left as draft, not published"
	fi
	"$GH" release edit "$tag" --draft=false >/dev/null || die "could not publish ${tag}"
	echo "release-guard: published ${tag}; all $# required assets present"
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
  "release view") [[ -z "${FAKE_VIEW_FAIL:-}" ]] || exit 1
    case "$*" in *'.name'*) printf '%s\n' "${FAKE_NAMES:-}" ;; *) echo "${FAKE_COUNT}" ;; esac ;;
  "release download") printf '%s\n' "${FAKE_SUMS:-}" ;;
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

	# publish-complete: the Windows .exe is a hard requirement (#3803).
	local req=('^8gent-windows-x64\.exe$' '^8gent-setup-.*-x64\.exe$' '^8gent-darwin-arm64$' '\.tgz$' '^SHA256SUMS$')
	local all=$'8gent-windows-x64.exe\n8gent-setup-0.20.0-x64.exe\n8gent-darwin-arm64\n8gi-foundation-8gent-code-0.20.0.tgz\nSHA256SUMS'
	local sums=$'h1  8gent-windows-x64.exe\nh2  8gent-setup-0.20.0-x64.exe\nh3  8gent-darwin-arm64\nh4  8gi-foundation-8gent-code-0.20.0.tgz'
	export FAKE_SUMS="$sums"
	: > "$FAKE_LOG"
	expect_fail "publish-complete: no windows exe fails" env GH="$tmp/gh" FAKE_NAMES=$'8gent-darwin-arm64\n8gi-foundation-8gent-code-0.20.0.tgz\nSHA256SUMS' bash "$self" publish-complete v9.9.9 "${req[@]}"
	expect_fail "publish-complete: empty release fails" env GH="$tmp/gh" FAKE_NAMES="" bash "$self" publish-complete v9.9.9 "${req[@]}"
	expect_fail "publish-complete: no patterns fails" env GH="$tmp/gh" FAKE_NAMES="$all" bash "$self" publish-complete v9.9.9
	expect_fail "publish-complete: gh view failure fails" env GH="$tmp/gh" FAKE_NAMES="$all" FAKE_VIEW_FAIL=1 bash "$self" publish-complete v9.9.9 "${req[@]}"
	if [[ -s "$FAKE_LOG" ]]; then bad "publish-complete: incomplete release never calls edit"; else ok "publish-complete: incomplete release never calls edit"; fi
	expect_fail "publish-complete: missing checksum line for the .exe fails" env GH="$tmp/gh" FAKE_NAMES="$all" FAKE_SUMS=$'h2  8gent-setup-0.20.0-x64.exe\nh3  8gent-darwin-arm64\nh4  8gi-foundation-8gent-code-0.20.0.tgz' bash "$self" publish-complete v9.9.9 "${req[@]}"
	expect_fail "publish-complete: empty SHA256SUMS fails" env GH="$tmp/gh" FAKE_NAMES="$all" FAKE_SUMS="" bash "$self" publish-complete v9.9.9 "${req[@]}"
	expect_fail "publish-complete: checksum for a prefix of the name does not count" env GH="$tmp/gh" FAKE_NAMES="$all" FAKE_SUMS=$'h1  8gent-windows-x64.exe.bak\nh2  8gent-setup-0.20.0-x64.exe\nh3  8gent-darwin-arm64\nh4  8gi-foundation-8gent-code-0.20.0.tgz' bash "$self" publish-complete v9.9.9 "${req[@]}"
	if [[ -s "$FAKE_LOG" ]]; then bad "publish-complete: unchecksummed release never calls edit"; else ok "publish-complete: unchecksummed release never calls edit"; fi
	expect_pass "publish-complete: full set passes" env GH="$tmp/gh" FAKE_NAMES="$all" bash "$self" publish-complete v9.9.9 "${req[@]}"
	if grep -q -- 'release edit v9.9.9 --draft=false' "$FAKE_LOG"; then ok "publish-complete: flips draft=false"; else bad "publish-complete: flips draft=false"; fi

	echo "release-guard selftest: ${pass} passed, ${fail} failed"
	[[ $fail -eq 0 ]]
}

case "${1:-}" in
	pack)     shift; pack "$@" ;;
	stage)    shift; stage "$@" ;;
	publish)  shift; publish "$@" ;;
	publish-complete) shift; publish_complete "$@" ;;
	selftest) selftest ;;
	*) echo "usage: $0 pack <dir> | stage <dir> | publish <tag> [min] | publish-complete <tag> <regex>... | selftest" >&2; exit 2 ;;
esac
