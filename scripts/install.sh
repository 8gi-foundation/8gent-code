#!/bin/sh
# 8gent Code installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/8gi-foundation/8gent-code/main/scripts/install.sh | sh
#
# Downloads the self-contained 8gent binary for this machine from the newest
# GitHub release that carries it, checks it against that release's SHA256SUMS,
# and installs it as `8gent`. No Bun, Node or npm needed. The Windows
# counterpart is scripts/install.ps1.
#
# Settings (environment variables, all optional):
#   EIGHT_VERSION       install this version (0.20.0 or v0.20.0) instead of the newest
#   EIGHT_INSTALL_DIR   where the binary goes (default: $HOME/.local/bin)
#   EIGHT_REPO          GitHub owner/repo (default: 8gi-foundation/8gent-code)
#   EIGHT_RELEASES_URL  the releases list to read (default: the GitHub API for EIGHT_REPO)
#
# It never replaces a newer 8gent with an older one unless EIGHT_VERSION asks
# for that version by name. Nothing is changed if the download, the checksum
# or the first run of the new binary fails.
set -eu

REPO="${EIGHT_REPO:-8gi-foundation/8gent-code}"
RELEASES_URL="${EIGHT_RELEASES_URL:-https://api.github.com/repos/${REPO}/releases?per_page=100}"
INSTALL_DIR="${EIGHT_INSTALL_DIR:-${HOME}/.local/bin}"
WANT="${EIGHT_VERSION:-}"
WANT="${WANT#v}"

say() { printf '%s\n' "$*"; }
die() { printf '8gent install: %s\n' "$*" >&2; exit 1; }

fetch() { # fetch URL OUTFILE
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --retry 2 -o "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -O "$2" "$1"
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

# Version printed by an installed 8gent ("8gent Code v0.20.0" -> 0.20.0), or nothing.
installed_version() {
	[ -x "$1" ] || return 0
	"$1" --version 2>/dev/null | sed -n 's/.*8gent Code v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1
}

case "$(uname -s)" in
	Darwin) os=darwin ;;
	Linux) os=linux ;;
	MINGW* | MSYS* | CYGWIN*) die "on Windows, run in PowerShell: irm https://raw.githubusercontent.com/${REPO}/main/scripts/install.ps1 | iex" ;;
	*) die "no 8gent binary for $(uname -s); install with npm instead: npm install -g @8gi-foundation/8gent-code" ;;
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
	die "the Linux binaries need glibc; on musl (Alpine) install with npm: npm install -g @8gi-foundation/8gent-code"
fi
ASSET="8gent-${os}-${arch}"

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t 8gent-install)"
trap 'rm -rf "$TMP"' EXIT
trap 'exit 130' INT TERM

fetch "$RELEASES_URL" "$TMP/releases.json" || die "could not read the release list at ${RELEASES_URL}"

# Every download URL for this machine's binary on a vX.Y.Z release, as "X.Y.Z URL".
# Drafts are not visible here, and pre-release tags (v1.0.0-rc.1) do not match.
grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*"' "$TMP/releases.json" \
	| sed 's/^"browser_download_url"[[:space:]]*:[[:space:]]*"//; s/"$//' \
	| grep -E "/releases/download/v[0-9]+\.[0-9]+\.[0-9]+/${ASSET}\$" \
	| sed -E 's#^(.*/releases/download/v([0-9]+\.[0-9]+\.[0-9]+)/.*)$#\2 \1#' \
	| sort -t. -k1,1n -k2,2n -k3,3n > "$TMP/candidates" || true

if [ -n "$WANT" ]; then
	line="$(awk -v v="$WANT" '$1 == v' "$TMP/candidates" | tail -n 1)"
	[ -n "$line" ] || die "release v${WANT} has no ${ASSET} binary (see https://github.com/${REPO}/releases)"
else
	line="$(tail -n 1 "$TMP/candidates")"
	[ -n "$line" ] || die "no release carries a ${ASSET} binary yet (see https://github.com/${REPO}/releases); npm install -g @8gi-foundation/8gent-code works meanwhile"
fi
VERSION="${line%% *}"
URL="${line#* }"
SUMS_URL="${URL%/*}/SHA256SUMS"

TARGET="${INSTALL_DIR}/8gent"
CURRENT="$(installed_version "$TARGET")"
if [ -n "$CURRENT" ] && [ -z "$WANT" ] && version_gt "$CURRENT" "$VERSION"; then
	say "8gent v${CURRENT} is already installed at ${TARGET}, newer than the newest release v${VERSION}. Nothing changed."
	say "To install v${VERSION} anyway: EIGHT_VERSION=${VERSION} sh install.sh"
	exit 0
fi
if [ "$CURRENT" = "$VERSION" ]; then
	say "8gent v${VERSION} is already installed at ${TARGET}."
	exit 0
fi

say "Downloading 8gent v${VERSION} (${ASSET})..."
fetch "$URL" "$TMP/$ASSET" || die "download failed: ${URL}"
fetch "$SUMS_URL" "$TMP/SHA256SUMS" || die "release v${VERSION} has no SHA256SUMS; refusing an unverified binary"
expected="$(awk -v f="$ASSET" '$2 == f || $2 == "*" f {print $1}' "$TMP/SHA256SUMS" | head -n 1)"
[ -n "$expected" ] || die "SHA256SUMS for v${VERSION} does not list ${ASSET}; refusing an unverified binary"
actual="$(sha256_of "$TMP/$ASSET")"
[ "$expected" = "$actual" ] || die "checksum mismatch for ${ASSET} (expected ${expected}, got ${actual}); nothing installed"

chmod 755 "$TMP/$ASSET"
got="$(installed_version "$TMP/$ASSET")"
[ "$got" = "$VERSION" ] || die "the downloaded binary did not report v${VERSION} (got '${got}'); nothing installed"

mkdir -p "$INSTALL_DIR"
# Copy beside the target, then rename over it: a running 8gent keeps its old file.
cp "$TMP/$ASSET" "${TARGET}.new.$$"
chmod 755 "${TARGET}.new.$$"
mv -f "${TARGET}.new.$$" "$TARGET"

say "Installed 8gent v${VERSION} to ${TARGET}"
case ":${PATH}:" in
	*":${INSTALL_DIR}:"*) say "Run: 8gent" ;;
	*)
		say "${INSTALL_DIR} is not on your PATH. Add this line to your shell profile (~/.zshrc or ~/.bashrc), then open a new terminal:"
		say "  export PATH=\"${INSTALL_DIR}:\$PATH\""
		;;
esac
