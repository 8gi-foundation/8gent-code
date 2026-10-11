#!/bin/sh
# 8gent Code installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/8gi-foundation/8gent-code/main/scripts/install.sh | sh
#
# Downloads the self-contained 8gent binary for this machine from the newest
# GitHub release that carries it and installs it as `8gent`. No Bun, Node or
# npm needed. The Windows counterpart is scripts/install.ps1.
#
# Trust chain, in order; any failure stops the install with nothing changed:
#   1. Only https, only github.com release downloads, and redirects only to
#      GitHub's download hosts (curl: --proto =https, every hop checked).
#   2. SHA256SUMS is signed with the release signing key embedded below
#      (minisign). It is checked with `minisign` when that is installed.
#   3. The binary is checked against GitHub's build provenance attestation with
#      `gh attestation verify` when the GitHub CLI is installed and signed in.
#   4. The binary's SHA256 must match SHA256SUMS, and its own --version must
#      name the release, before it replaces anything.
# Set EIGHT_REQUIRE_VERIFIED=1 to refuse an install unless step 2 or 3 ran.
#
# Settings (environment variables, all optional):
#   EIGHT_VERSION           install this version (0.20.0 or v0.20.0) instead of the newest
#   EIGHT_INSTALL_DIR       where the binary goes (default: $HOME/.local/bin)
#   EIGHT_REPO              GitHub owner/repo (default: 8gi-foundation/8gent-code)
#   EIGHT_RELEASES_URL      the releases list (https, or http://127.0.0.1 for tests)
#   EIGHT_REQUIRE_VERIFIED  1 = refuse unless the signature or attestation was checked
#
# It never replaces a newer 8gent with an older one unless EIGHT_VERSION asks
# for that version by name.

# Release signing key (minisign public key, base64). Kept identical to
# scripts/release-signing.pub by scripts/lib/install-sh.test.ts. Empty until
# the maintainer generates the release key; see that file.
EIGHT_SIGNING_KEY=""

say() { printf '%s\n' "$*"; }
warn() { printf '8gent install: warning: %s\n' "$*" >&2; }
die() {
	printf '8gent install: %s\n' "$*" >&2
	exit 1
}

host_of() { printf '%s' "$1" | sed -E 's#^[a-zA-Z]+://([^/:?#]+).*#\1#'; }

# url_allowed URL KIND: KIND is "list", "asset" or "hop" (a redirect target).
url_allowed() {
	if [ "$LOCAL" = 1 ]; then
		case "$1" in http://127.0.0.1:* | http://127.0.0.1/*) return 0 ;; *) return 1 ;; esac
	fi
	case "$1" in https://*) ;; *) return 1 ;; esac
	case "$2" in
		list) return 0 ;;
		asset) case "$1" in "https://github.com/${REPO}/releases/download/"*) return 0 ;; *) return 1 ;; esac ;;
		hop)
			case "$(host_of "$1")" in
				github.com | api.github.com | objects.githubusercontent.com | release-assets.githubusercontent.com) return 0 ;;
				*) return 1 ;;
			esac
			;;
	esac
	return 1
}

# fetch URL OUTFILE KIND: download, checking the URL and every redirect hop.
fetch() {
	url="$1"
	url_allowed "$url" "$3" || die "refusing to download from ${url}"
	if command -v curl >/dev/null 2>&1; then
		if [ "$LOCAL" = 1 ]; then proto="=http,https"; else proto="=https"; fi
		hops=0
		while :; do
			res="$(curl -sS --proto "$proto" --max-redirs 0 -o "$2" -w '%{http_code} %{redirect_url}' "$url")" || return 1
			code="${res%% *}"
			next="${res#* }"
			case "$code" in
				200) return 0 ;;
				301 | 302 | 303 | 307 | 308)
					hops=$((hops + 1))
					[ "$hops" -le 5 ] || die "too many redirects for $1"
					url_allowed "$next" hop || die "refusing a redirect to ${next}"
					url="$next"
					;;
				*) return 1 ;;
			esac
		done
	elif command -v wget >/dev/null 2>&1; then
		if [ "$LOCAL" = 1 ]; then
			wget -q -O "$2" "$url"
		else
			wget -q --https-only -O "$2" "$url"
		fi
	else
		die "needs curl or wget"
	fi
}

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{print $1}'
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | awk '{print $1}'
	else
		die "needs sha256sum or shasum to verify the download"
	fi
}

# version_gt A B: true when semver A is strictly higher than B (X.Y.Z only).
version_gt() {
	awk -v a="$1" -v b="$2" 'BEGIN {
		split(a, x, "."); split(b, y, ".")
		for (i = 1; i <= 3; i++) {
			if (x[i] + 0 > y[i] + 0) exit 0
			if (x[i] + 0 < y[i] + 0) exit 1
		}
		exit 1
	}'
}

# Run a binary's --version with a 15 second limit.
run_version() {
	if command -v timeout >/dev/null 2>&1; then
		timeout 15 "$1" --version 2>/dev/null
	elif command -v perl >/dev/null 2>&1; then
		perl -e 'alarm shift; exec @ARGV' 15 "$1" --version 2>/dev/null
	else
		"$1" --version 2>/dev/null
	fi
}

# Version printed by an 8gent binary ("8gent Code v0.20.0" -> 0.20.0), or nothing.
installed_version() {
	[ -x "$1" ] || return 0
	run_version "$1" | sed -n 's/.*8gent Code v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1
}

# From a GitHub releases JSON (a list or one release): "X.Y.Z URL" for each
# download URL of ASSET on a published, non-prerelease vX.Y.Z release. Reads
# the keys in document order (GitHub puts tag_name, draft and prerelease
# before assets); quotes inside release notes are escaped (\") in JSON, so
# note text cannot match these patterns.
release_candidates() {
	grep -oE '"(tag_name|draft|prerelease)"[ 	]*:[ 	]*("[^"]*"|true|false)|"browser_download_url"[ 	]*:[ 	]*"[^"]*"' "$1" |
		awk -v asset="$2" '
			{ key = $0; sub(/^"/, "", key); sub(/".*/, "", key); val = $0; sub(/^[^:]*:[ \t]*/, "", val); gsub(/"/, "", val) }
			key == "tag_name" { tag = val; draft = 0; pre = 0; next }
			key == "draft" { draft = (val == "true"); next }
			key == "prerelease" { pre = (val == "true"); next }
			key == "browser_download_url" {
				if (draft || pre || tag !~ /^v[0-9]+\.[0-9]+\.[0-9]+$/) next
				n = split(val, parts, "/")
				if (parts[n] != asset || parts[n - 1] != tag) next
				print substr(tag, 2) " " val
			}' |
		sort -t. -k1,1n -k2,2n -k3,3n
}

# url_for LIST_JSON TAG NAME: download URL of NAME on release TAG, or nothing.
url_for() {
	grep -oE '"browser_download_url"[ 	]*:[ 	]*"[^"]*"' "$1" |
		sed 's/^"browser_download_url"[ 	]*:[ 	]*"//; s/"$//' |
		grep -F "/releases/download/$2/$3" | grep -E "/$3\$" | head -n 1
}

main() {
	set -eu
	REPO="${EIGHT_REPO:-8gi-foundation/8gent-code}"
	RELEASES_URL="${EIGHT_RELEASES_URL:-https://api.github.com/repos/${REPO}/releases?per_page=100}"
	INSTALL_DIR="${EIGHT_INSTALL_DIR:-${HOME}/.local/bin}"
	WANT="${EIGHT_VERSION:-}"
	WANT="${WANT#v}"

	LOCAL=0
	case "$RELEASES_URL" in
		https://*) ;;
		http://127.0.0.1:* | http://127.0.0.1/*) LOCAL=1 ;;
		*) die "EIGHT_RELEASES_URL must be https (or http://127.0.0.1 for tests): ${RELEASES_URL}" ;;
	esac
	# A local test server may supply its own key; a real install trusts only the embedded one.
	KEY="$EIGHT_SIGNING_KEY"
	if [ "$LOCAL" = 1 ] && [ -n "${EIGHT_TEST_SIGNING_KEY:-}" ]; then KEY="$EIGHT_TEST_SIGNING_KEY"; fi

	case "$(uname -s)" in
		Darwin) os=darwin ;;
		Linux) os=linux ;;
		MINGW* | MSYS* | CYGWIN*) die "on Windows, run in PowerShell: irm https://raw.githubusercontent.com/${REPO}/main/scripts/install.ps1 | iex" ;;
		*) die "no 8gent binary for $(uname -s)" ;;
	esac
	case "$(uname -m)" in
		x86_64 | amd64) arch=x64 ;;
		arm64 | aarch64) arch=arm64 ;;
		*) die "no 8gent binary for $(uname -m)" ;;
	esac
	# An x64 shell under Rosetta on Apple Silicon still gets the native build.
	if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then
		arch=arm64
	fi
	if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
		die "the Linux binaries need glibc; this looks like musl (Alpine)"
	fi
	ASSET="8gent-${os}-${arch}"

	TMP="$(mktemp -d 2>/dev/null || mktemp -d -t 8gent-install)"
	trap 'rm -rf "$TMP"' EXIT
	trap 'exit 130' INT TERM

	fetch "$RELEASES_URL" "$TMP/releases.json" list || die "could not read the release list at ${RELEASES_URL}"
	release_candidates "$TMP/releases.json" "$ASSET" >"$TMP/candidates" || true

	if [ -n "$WANT" ]; then
		line="$(awk -v v="$WANT" '$1 == v' "$TMP/candidates" | tail -n 1)"
		[ -n "$line" ] || die "release v${WANT} has no ${ASSET} binary (see https://github.com/${REPO}/releases)"
	else
		line="$(tail -n 1 "$TMP/candidates")"
		[ -n "$line" ] || die "no release carries a ${ASSET} binary yet (see https://github.com/${REPO}/releases)"
	fi
	VERSION="${line%% *}"
	URL="${line#* }"
	TAG="v${VERSION}"
	url_allowed "$URL" asset || die "refusing a download URL outside ${REPO}'s releases: ${URL}"

	TARGET="${INSTALL_DIR}/8gent"
	CURRENT="$(installed_version "$TARGET")"
	if [ -n "$CURRENT" ] && [ -z "$WANT" ] && version_gt "$CURRENT" "$VERSION"; then
		say "8gent v${CURRENT} is already installed at ${TARGET}, newer than the newest release v${VERSION}. Nothing changed."
		say "To install v${VERSION} anyway, set EIGHT_VERSION=${VERSION}."
		exit 0
	fi
	if [ "$CURRENT" = "$VERSION" ]; then
		say "8gent v${VERSION} is already installed at ${TARGET}."
		exit 0
	fi

	SUMS_URL="$(url_for "$TMP/releases.json" "$TAG" SHA256SUMS)"
	[ -n "$SUMS_URL" ] || die "release v${VERSION} has no SHA256SUMS; refusing an unverified binary"
	url_allowed "$SUMS_URL" asset || die "refusing a download URL outside ${REPO}'s releases: ${SUMS_URL}"
	fetch "$SUMS_URL" "$TMP/SHA256SUMS" asset || die "could not download SHA256SUMS for v${VERSION}"

	verified=0
	if [ -n "$KEY" ]; then
		SIG_URL="$(url_for "$TMP/releases.json" "$TAG" SHA256SUMS.minisig)"
		[ -n "$SIG_URL" ] || die "release v${VERSION} has no SHA256SUMS.minisig; refusing unsigned checksums"
		url_allowed "$SIG_URL" asset || die "refusing a download URL outside ${REPO}'s releases: ${SIG_URL}"
		fetch "$SIG_URL" "$TMP/SHA256SUMS.minisig" asset || die "could not download SHA256SUMS.minisig for v${VERSION}"
		if command -v minisign >/dev/null 2>&1; then
			minisign -q -V -m "$TMP/SHA256SUMS" -x "$TMP/SHA256SUMS.minisig" -P "$KEY" >/dev/null 2>&1 ||
				die "SHA256SUMS for v${VERSION} does not carry a valid release signature; nothing installed"
			say "Release signature on SHA256SUMS: verified."
			verified=1
		fi
	fi

	say "Downloading 8gent v${VERSION} (${ASSET})..."
	fetch "$URL" "$TMP/$ASSET" asset || die "download failed: ${URL}"
	expected="$(awk -v f="$ASSET" '$2 == f || $2 == "*" f {print $1}' "$TMP/SHA256SUMS" | head -n 1)"
	[ -n "$expected" ] || die "SHA256SUMS for v${VERSION} does not list ${ASSET}; refusing an unverified binary"
	actual="$(sha256_of "$TMP/$ASSET")"
	[ "$expected" = "$actual" ] || die "checksum mismatch for ${ASSET} (expected ${expected}, got ${actual}); nothing installed"

	if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
		gh attestation verify "$TMP/$ASSET" --repo "$REPO" >/dev/null 2>&1 ||
			die "GitHub build attestation for ${ASSET} v${VERSION} did not verify; nothing installed"
		say "GitHub build attestation: verified."
		verified=1
	fi
	if [ "$verified" = 0 ]; then
		if [ "${EIGHT_REQUIRE_VERIFIED:-}" = 1 ]; then
			die "EIGHT_REQUIRE_VERIFIED=1 but neither minisign nor a signed-in GitHub CLI (gh) is available to verify the release"
		fi
		warn "only the SHA256 checksum was checked. Install minisign, or the GitHub CLI and run gh auth login, to also verify the release signature or build attestation."
	fi

	chmod 755 "$TMP/$ASSET"
	got="$(installed_version "$TMP/$ASSET")"
	[ "$got" = "$VERSION" ] || die "the downloaded binary did not report v${VERSION} (got '${got}'); nothing installed"

	mkdir -p "$INSTALL_DIR"
	# A uniquely named file beside the target, then a rename over it: atomic,
	# and a running 8gent keeps its old file.
	staged="$(mktemp "${INSTALL_DIR}/.8gent.XXXXXX")"
	cp "$TMP/$ASSET" "$staged"
	chmod 755 "$staged"
	mv -f "$staged" "$TARGET"

	say "Installed 8gent v${VERSION} to ${TARGET}"
	case ":${PATH}:" in
		*":${INSTALL_DIR}:"*)
			found="$(command -v 8gent 2>/dev/null || true)"
			if [ -n "$found" ] && [ "$found" != "$TARGET" ]; then
				warn "\`8gent\` on your PATH is ${found}, not ${TARGET} (often an older npm install)."
				warn "Fix: npm uninstall -g @8gi-foundation/8gent-code, or put ${INSTALL_DIR} earlier in PATH."
			else
				say "Run: 8gent"
			fi
			;;
		*)
			say "${INSTALL_DIR} is not on your PATH. Add this line to your shell profile (~/.zshrc or ~/.bashrc), then open a new terminal:"
			say "  export PATH=\"${INSTALL_DIR}:\$PATH\""
			;;
	esac
}

main "$@"
