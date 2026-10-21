#!/bin/sh
# 8gent Code installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/8gi-foundation/8gent-code/main/scripts/install.sh | sh
#
# Downloads the self-contained 8gent binary for this machine from the newest
# GitHub release that carries it and installs it as `8gent`. No Bun, Node or
# npm needed. The Windows counterpart is scripts/install.ps1.
#
# The release list comes from api.github.com. When that is rate limited (60
# unauthenticated requests an hour per IP) or down, the installer reads the
# newest published release from github.com/<repo>/releases/latest instead and
# checks each file it needs exists there. EIGHT_VERSION skips the list entirely.
#
# Trust chain, in order; any failure stops the install with nothing changed:
#   1. Only https, only github.com release downloads, and redirects only to
#      GitHub's download hosts (curl: --proto =https, every hop checked).
#   2. SHA256SUMS is signed with the release signing key embedded below
#      (minisign). Once a key is embedded the signature is REQUIRED: it is
#      checked with `minisign` from PATH, or else with minisign 0.12 downloaded
#      from github.com/jedisct1/minisign and pinned by the SHA256 below.
#      EIGHT_ALLOW_UNVERIFIED=1 is the explicit opt-out when no verifier can run.
#   3. The binary is checked against GitHub's build provenance attestation
#      (signed by release-binaries.yml for this tag) with `gh attestation
#      verify` when the GitHub CLI is installed and signed in.
#   4. The binary's SHA256 must match SHA256SUMS, and its own --version must
#      name the release, before it replaces anything.
#
# Settings (environment variables, all optional):
#   EIGHT_VERSION           install this version (0.20.0 or v0.20.0) instead of the newest; no API call
#   EIGHT_INSTALL_DIR       where the binary goes (default: $HOME/.local/bin)
#   EIGHT_REPO              GitHub owner/repo (default: 8gi-foundation/8gent-code)
#   EIGHT_RELEASES_URL      the releases list (https, or http://127.0.0.1 for tests)
#   EIGHT_ALLOW_UNVERIFIED  1 = continue when a release key exists but no minisign can run
#   EIGHT_INSTALL_DEBUG     1 = print what was detected (OS, libc, asset, install dir) and carry on
#   EIGHT_ANDROID_FORCE     1 = on Android/Termux, use the glibc binary path instead of npm (glibc-runner setups)
#
# On Android (Termux) the binary cannot run (bionic, not glibc), so the release's
# npm package is installed instead: nodejs via pkg when missing or older than
# 22.5, then npm i -g --ignore-scripts on the .tgz, after the same SHA256SUMS (and
# signature) check. No install scripts run: dependency scripts (sharp and others)
# fail on bionic and are not covered by the checksum.
#   --dry-run               argument: print the detection and stop before any download
#
# It never replaces a newer 8gent with an older one unless EIGHT_VERSION asks
# for that version by name.

# Release signing key (minisign public key, base64). Kept identical to
# scripts/release-signing.pub by scripts/lib/install-sh.test.ts. Empty until
# the maintainer generates the release key; see that file.
EIGHT_SIGNING_KEY=""

# Pinned signature verifier, used only when minisign is not on PATH.
# Release 0.12 of github.com/jedisct1/minisign; each archive's SHA256 was
# checked against jedisct1's published minisign signature when pinned.
MINISIGN_VERSION="0.12"
MINISIGN_LINUX_SHA256="9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73"
MINISIGN_MACOS_SHA256="89000b19535765f9cffc65a65d64a820f433ef6db8020667f7570e06bf6aac63"

say() { printf '%s\n' "$*"; }
warn() { printf '8gent install: warning: %s\n' "$*" >&2; }
die() {
	printf '8gent install: %s\n' "$*" >&2
	exit 1
}

host_of() { printf '%s' "$1" | sed -E 's#^[a-zA-Z]+://([^/:?#]+).*#\1#'; }

is_local_url() { case "$1" in http://127.0.0.1:* | http://127.0.0.1/*) return 0 ;; *) return 1 ;; esac; }

# url_allowed URL KIND: KIND is "list", "asset", "verifier" (the pinned
# minisign download), "hop" (a redirect target) or "verifier-hop".
url_allowed() {
	case "$2" in
		verifier)
			if [ "$LOCAL" = 1 ] && is_local_url "$1"; then return 0; fi
			case "$1" in "https://github.com/jedisct1/minisign/releases/download/"*) return 0 ;; *) return 1 ;; esac
			;;
		verifier-hop)
			if [ "$LOCAL" = 1 ] && is_local_url "$1"; then return 0; fi
			url_allowed_remote "$1" hop
			return
			;;
	esac
	if [ "$LOCAL" = 1 ]; then
		is_local_url "$1"
		return
	fi
	url_allowed_remote "$1" "$2"
}

url_allowed_remote() {
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
# Redirects are never followed by the tool itself: each hop is checked here.
fetch() {
	url="$1"
	url_allowed "$url" "$3" || die "refusing to download from ${url}"
	hopkind=hop
	[ "$3" = verifier ] && hopkind=verifier-hop
	if is_local_url "$url"; then proto="=http,https"; else proto="=https"; fi
	hops=0
	while :; do
		if command -v curl >/dev/null 2>&1 && [ -z "${EIGHT_TEST_FORCE_WGET:-}" ]; then
			# A token is optional (CI smoke runs only) and goes to the first hop of the
			# release list on api.github.com only, via stdin so it is never in argv.
			if [ "$3" = list ] && [ "$hops" -eq 0 ] && [ -n "${EIGHT_INSTALL_GITHUB_TOKEN:-}" ] && [ "$(host_of "$url")" = api.github.com ]; then
				res="$(printf 'header = "Authorization: Bearer %s"\n' "$EIGHT_INSTALL_GITHUB_TOKEN" | curl -sS -K - --proto "$proto" --max-redirs 0 -o "$2" -w '%{http_code} %{redirect_url}' "$url")" || { FETCH_STATUS="curl-error"; return 1; }
			else
				res="$(curl -sS --proto "$proto" --max-redirs 0 -o "$2" -w '%{http_code} %{redirect_url}' "$url")" || { FETCH_STATUS="curl-error"; return 1; }
			fi
			code="${res%% *}"
			next="${res#* }"
		elif command -v wget >/dev/null 2>&1; then
			if is_local_url "$url"; then https_only=""; else https_only="--https-only"; fi
			# shellcheck disable=SC2086
			wget -S --max-redirect=0 $https_only -O "$2" "$url" 2>"$2.hdr" || true
			code="$(awk '/^  HTTP\//{c=$2} END{print c}' "$2.hdr")"
			next="$(awk 'tolower($1)=="location:"{l=$2} END{print l}' "$2.hdr" | tr -d '\r')"
			rm -f "$2.hdr"
			case "$next" in "" | http://* | https://*) ;; /*) next="$(printf '%s' "$url" | sed -E 's#^([a-z]+://[^/]+).*#\1#')${next}" ;; esac
		else
			die "needs curl or wget"
		fi
		FETCH_STATUS="$code"
		case "$code" in
			200) return 0 ;;
			301 | 302 | 303 | 307 | 308)
				hops=$((hops + 1))
				[ "$hops" -le 5 ] || die "too many redirects for $1"
				url_allowed "$next" "$hopkind" || die "refusing a redirect to ${next}"
				url="$next"
				if is_local_url "$url"; then proto="=http,https"; else proto="=https"; fi
				;;
			*) return 1 ;;
		esac
	done
}

# fetch_list: the release list from an unauthenticated runner can be rate
# limited or blip (the v0.20.0 macOS smoke died in 0.3 s on it, #4468), so
# retry transient failures (transport error, 403, 429, 5xx) 3 times with 2 s,
# 4 s, 8 s backoff and report the last HTTP status.
fetch_list() {
	attempt=0
	delay=2
	while :; do
		FETCH_STATUS=""
		if fetch "$RELEASES_URL" "$1" list; then return 0; fi
		# Only transient answers are retried; a 401 or 404 will not change.
		case "$FETCH_STATUS" in curl-error | 403 | 429 | 5??) ;; *) break ;; esac
		[ "$attempt" -lt 3 ] || break
		attempt=$((attempt + 1))
		if [ "$LOCAL" = 1 ] && [ -n "${EIGHT_TEST_RETRY_DELAY:-}" ]; then sleep "$EIGHT_TEST_RETRY_DELAY"; else sleep "$delay"; fi
		delay=$((delay * 2))
	done
	return 1
}

# head_once URL: one HEAD request, no redirects followed. Sets HEAD_CODE and
# HEAD_NEXT (the absolute redirect target, or empty). The caller checks URLs.
head_once() {
	HEAD_CODE=""
	HEAD_NEXT=""
	if is_local_url "$1"; then hproto="=http,https"; else hproto="=https"; fi
	if command -v curl >/dev/null 2>&1 && [ -z "${EIGHT_TEST_FORCE_WGET:-}" ]; then
		hres="$(curl -sS -I --proto "$hproto" --max-redirs 0 -o /dev/null -w '%{http_code} %{redirect_url}' "$1")" || { HEAD_CODE="curl-error"; return 1; }
		HEAD_CODE="${hres%% *}"
		HEAD_NEXT="${hres#* }"
	elif command -v wget >/dev/null 2>&1; then
		if is_local_url "$1"; then https_only=""; else https_only="--https-only"; fi
		# shellcheck disable=SC2086
		hhdr="$(wget -S --spider --max-redirect=0 $https_only "$1" 2>&1 >/dev/null || true)"
		HEAD_CODE="$(printf '%s\n' "$hhdr" | awk '/^  HTTP\//{c=$2} END{print c}')"
		HEAD_NEXT="$(printf '%s\n' "$hhdr" | awk 'tolower($1)=="location:"{l=$2} END{print l}' | tr -d '\r')"
		case "$HEAD_NEXT" in "" | http://* | https://*) ;; /*) HEAD_NEXT="$(printf '%s' "$1" | sed -E 's#^([a-z]+://[^/]+).*#\1#')${HEAD_NEXT}" ;; esac
	else
		die "needs curl or wget"
	fi
	[ -n "$HEAD_CODE" ] || HEAD_CODE="none"
}

# valid_semver X: X is exactly N.N.N (digits and dots only, so no newline can
# slip a second line past grep).
valid_semver() {
	case "$1" in '' | *[!0-9.]*) return 1 ;; esac
	printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'
}

# latest_from_site: the no-API way to find the newest published release.
# GitHub answers SITE/latest with a redirect to SITE/tag/<tag>; that page
# skips drafts and prereleases. Sets VERSION, or returns 1 with LATEST_WHY.
latest_from_site() {
	LATEST_WHY=""
	lurl="${SITE}/latest"
	url_allowed "$lurl" list || die "refusing to read ${lurl}"
	head_once "$lurl" || { LATEST_WHY="${lurl} did not answer (${HEAD_CODE})"; return 1; }
	case "$HEAD_CODE" in
		301 | 302 | 303 | 307 | 308) ;;
		*) LATEST_WHY="${lurl} answered ${HEAD_CODE}, not a redirect to a release"; return 1 ;;
	esac
	case "$HEAD_NEXT" in
		"${SITE}/tag/"*) ltag="${HEAD_NEXT#"${SITE}/tag/"}" ;;
		*) LATEST_WHY="${lurl} redirected outside ${SITE}/tag/: ${HEAD_NEXT}"; return 1 ;;
	esac
	case "$ltag" in
		v*) lver="${ltag#v}" ;;
		*) lver="" ;;
	esac
	valid_semver "$lver" || { LATEST_WHY="the newest release tag is not vX.Y.Z: $(printf '%s' "$ltag" | head -c 80)"; return 1; }
	VERSION="$lver"
}

# probe URL: does this release download exist? HEAD the github.com download
# URL: 200, or a redirect to an allowed download host, means yes. The CDN hop
# is not requested: its signed URLs are made for GET. Every hop is checked.
probe() {
	purl="$1"
	phops=0
	while :; do
		head_once "$purl" || return 1
		case "$HEAD_CODE" in
			200) return 0 ;;
			301 | 302 | 303 | 307 | 308)
				url_allowed "$HEAD_NEXT" hop || die "refusing a redirect to ${HEAD_NEXT}"
				# A local test server has no CDN: keep following there.
				is_local_url "$HEAD_NEXT" || return 0
				phops=$((phops + 1))
				[ "$phops" -le 5 ] || die "too many redirects for $1"
				purl="$HEAD_NEXT"
				;;
			*) return 1 ;;
		esac
	done
}

# release_asset NAME: set AURL to NAME's download URL on release TAG, checked
# against the allowed hosts. Returns 1 when the release does not carry it.
# With the API list it comes from the list; without, it is built from the
# releases page and its existence is checked with probe.
release_asset() {
	AURL=""
	if [ "$NOAPI" = 1 ]; then
		cand="${SITE}/download/${TAG}/$1"
		url_allowed "$cand" asset || die "refusing a download URL outside ${REPO}'s releases: ${cand}"
		probe "$cand" || return 1
		AURL="$cand"
	else
		AURL="$(url_for "$TMP/releases.json" "$TAG" "$1")"
		[ -n "$AURL" ] || return 1
		url_allowed "$AURL" asset || die "refusing a download URL outside ${REPO}'s releases: ${AURL}"
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

# Set MS_BIN to a minisign that can run here: the one on PATH, or the pinned
# 0.12 release downloaded and checked against its embedded SHA256. Empty when
# neither is possible (no pinned build for this platform, or no unzip/tar).
find_minisign() {
	MS_BIN=""
	if command -v minisign >/dev/null 2>&1; then
		MS_BIN="minisign"
		return 0
	fi
	# Test servers only: behave as a machine with no usable verifier.
	if [ "$LOCAL" = 1 ] && [ -n "${EIGHT_TEST_NO_VERIFIER:-}" ]; then return 0; fi
	case "${os}-${arch}" in
		linux-x64) a="minisign-${MINISIGN_VERSION}-linux.tar.gz" sha="$MINISIGN_LINUX_SHA256" inner="minisign-linux/x86_64/minisign" ;;
		linux-arm64) a="minisign-${MINISIGN_VERSION}-linux.tar.gz" sha="$MINISIGN_LINUX_SHA256" inner="minisign-linux/aarch64/minisign" ;;
		darwin-arm64) a="minisign-${MINISIGN_VERSION}-macos.zip" sha="$MINISIGN_MACOS_SHA256" inner="minisign" ;;
		*) return 0 ;;
	esac
	murl="https://github.com/jedisct1/minisign/releases/download/${MINISIGN_VERSION}/${a}"
	if [ "$LOCAL" = 1 ] && [ -n "${EIGHT_TEST_MINISIGN_URL:-}" ]; then
		murl="$EIGHT_TEST_MINISIGN_URL"
		sha="${EIGHT_TEST_MINISIGN_SHA256:-$sha}"
	fi
	say "Fetching the pinned signature verifier (minisign ${MINISIGN_VERSION})..."
	fetch "$murl" "$TMP/$a" verifier || die "could not download the signature verifier from ${murl}"
	got_sha="$(sha256_of "$TMP/$a")"
	[ "$got_sha" = "$sha" ] || die "the downloaded minisign does not match its pinned SHA256 (expected ${sha}, got ${got_sha}); nothing installed"
	mkdir -p "$TMP/minisign"
	case "$a" in
		*.tar.gz) tar -xzf "$TMP/$a" -C "$TMP/minisign" "$inner" ;;
		*.zip)
			command -v unzip >/dev/null 2>&1 || return 0
			unzip -q -o "$TMP/$a" "$inner" -d "$TMP/minisign"
			;;
	esac
	chmod 755 "$TMP/minisign/$inner"
	MS_BIN="$TMP/minisign/$inner"
}

NODE_MIN="22.5"

# node_ok: node exists and is at least NODE_MIN (what package.json engines asks).
node_ok() {
	command -v node >/dev/null 2>&1 || return 1
	nv="$(node -p 'process.versions.node' 2>/dev/null)" || return 1
	nmaj="${nv%%.*}"; nrest="${nv#*.}"; nmin="${nrest%%.*}"
	case "$nmaj$nmin" in '' | *[!0-9]*) return 1 ;; esac
	wmaj="${NODE_MIN%%.*}"; wmin="${NODE_MIN#*.}"
	[ "$nmaj" -gt "$wmaj" ] || { [ "$nmaj" -eq "$wmaj" ] && [ "$nmin" -ge "$wmin" ]; }
}

# ensure_node: on Termux, install nodejs (npm comes with it) when missing or too old.
ensure_node() {
	node_ok && return 0
	command -v pkg >/dev/null 2>&1 || die "needs Node ${NODE_MIN} or newer and Termux's pkg is not available to install it"
	say "Installing nodejs with pkg (needs ${NODE_MIN} or newer)..."
	pkg install -y nodejs || die "pkg could not install nodejs; nothing installed"
	node_ok || die "nodejs from pkg is still older than ${NODE_MIN}; nothing installed"
	command -v npm >/dev/null 2>&1 || die "npm is missing after installing nodejs; nothing installed"
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
		*) die "EIGHT_RELEASES_URL must be https (or http://127.0.0.1 for tests): $(printf '%s' "$RELEASES_URL" | sed -E 's#^([a-zA-Z]+://)[^/@]*@#\1#; s#\?.*$#?...#')" ;;
	esac
	# The releases page, used when the API list is unavailable or not needed.
	if [ "$LOCAL" = 1 ]; then
		SITE="$(printf '%s' "$RELEASES_URL" | sed -E 's#^(http://127\.0\.0\.1(:[0-9]+)?).*#\1#')/releases"
	else
		SITE="https://github.com/${REPO}/releases"
	fi
	# A local test server may supply its own key; a real install trusts only the embedded one.
	KEY="$EIGHT_SIGNING_KEY"
	if [ "$LOCAL" = 1 ] && [ -n "${EIGHT_TEST_SIGNING_KEY:-}" ]; then KEY="$EIGHT_TEST_SIGNING_KEY"; fi

	DRY_RUN=0
	for a in "$@"; do
		case "$a" in
			--dry-run) DRY_RUN=1 ;;
			*) die "unknown option: $a (try --dry-run)" ;;
		esac
	done
	DEBUG=0
	if [ "$DRY_RUN" = 1 ] || [ "${EIGHT_INSTALL_DEBUG:-}" = 1 ]; then DEBUG=1; fi

	uname_s="$(uname -s 2>/dev/null || echo unknown)"
	uname_m="$(uname -m 2>/dev/null || echo unknown)"
	uname_o="$(uname -o 2>/dev/null || echo unknown)"
	# Android (Termux): the kernel says Linux, but the C library is bionic, not
	# glibc, and the release binaries are glibc builds that cannot start there.
	android=0
	case "$uname_o" in Android) android=1 ;; esac
	if [ -n "${TERMUX_VERSION:-}" ]; then android=1; fi
	case "${PREFIX:-}" in */com.termux/*) android=1 ;; esac

	case "$uname_s" in
		Darwin) os=darwin ;;
		Linux) os=linux ;;
		MINGW* | MSYS* | CYGWIN*) die "on Windows, run in PowerShell: irm https://raw.githubusercontent.com/${REPO}/main/scripts/install.ps1 | iex" ;;
		*) die "no 8gent binary for ${uname_s}" ;;
	esac
	case "$uname_m" in
		x86_64 | amd64) arch=x64 ;;
		arm64 | aarch64) arch=arm64 ;;
		armv8*) if [ "$android" = 1 ]; then arch=arm64; else die "no 8gent binary for ${uname_m}"; fi ;;
		*) die "no 8gent binary for ${uname_m}" ;;
	esac
	# An x64 shell under Rosetta on Apple Silicon still gets the native build.
	if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then
		arch=arm64
	fi
	libc=glibc
	if [ "$os" = linux ] && [ "$android" = 1 ]; then
		libc=bionic
	elif [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
		libc=musl
	fi
	ASSET="8gent-${os}-${arch}"
	# Bionic cannot run the glibc binary: Termux installs the release's npm package.
	# (proot-distro userlands answer as glibc Linux and never reach this.)
	NPM_PATH=0
	if [ "$libc" = bionic ] && [ "${EIGHT_ANDROID_FORCE:-}" != 1 ]; then NPM_PATH=1; fi
	# Termux has no /usr and no sudo; its bin directory is $PREFIX/bin, already on PATH.
	if [ "$android" = 1 ] && [ -z "${EIGHT_INSTALL_DIR:-}" ] && [ -n "${PREFIX:-}" ]; then
		INSTALL_DIR="${PREFIX}/bin"
	fi

	if [ "$DEBUG" = 1 ]; then
		say "8gent install: decisions"
		say "  uname -s/-m/-o : ${uname_s} / ${uname_m} / ${uname_o}"
		say "  android         : $([ "$android" = 1 ] && echo yes || echo no) (TERMUX_VERSION=${TERMUX_VERSION:-unset} PREFIX=${PREFIX:-unset})"
		say "  libc            : ${libc}"
		say "  asset           : ${ASSET}"
		say "  method          : $([ "$NPM_PATH" = 1 ] && echo "npm package (Termux, needs node >= ${NODE_MIN})" || echo "binary")"
		say "  install dir     : ${INSTALL_DIR}"
		say "  fetch tools     : curl=$(command -v curl >/dev/null 2>&1 && echo yes || echo no) wget=$(command -v wget >/dev/null 2>&1 && echo yes || echo no)"
		say "  releases url    : $(printf '%s' "$RELEASES_URL" | sed -E 's#^([a-zA-Z]+://)[^/@]*@#\1#; s#\?.*$#?...#')"
	fi

	if [ "$libc" = bionic ] && [ "${EIGHT_ANDROID_FORCE:-}" = 1 ]; then
		warn "EIGHT_ANDROID_FORCE=1: continuing on Android; the install will fail unless this box runs glibc binaries."
	fi
	if [ "$DRY_RUN" = 1 ]; then
		if [ "$NPM_PATH" = 1 ]; then say "  result          : a real run would install nodejs with pkg if needed, then the release npm package"; fi
		say "Dry run: nothing downloaded or installed."
		exit 0
	fi
	[ "$libc" != musl ] || die "the Linux binaries need glibc; this looks like musl (Alpine)"

	TMP="$(mktemp -d 2>/dev/null || mktemp -d -t 8gent-install)"
	# A relative TMPDIR gives a relative path; npm reads "dir/x.tgz" as a
	# package spec, not a file, so pin the verified file to an absolute path.
	case "$TMP" in /*) ;; *) TMP="$(pwd)/$TMP" ;; esac
	trap 'rm -rf "$TMP"' EXIT
	trap 'exit 130' INT TERM

	# Which release. EIGHT_VERSION needs no list at all. Otherwise the API list
	# (newest vX.Y.Z carrying this asset); when the API is rate limited or down,
	# the releases page names the newest published release instead.
	NOAPI=0
	if [ -n "$WANT" ]; then
		valid_semver "$WANT" || die "EIGHT_VERSION must look like 0.20.0 or v0.20.0, got: $(printf '%s' "${EIGHT_VERSION}" | head -c 80)"
		NOAPI=1
		VERSION="$WANT"
	elif fetch_list "$TMP/releases.json"; then
		release_candidates "$TMP/releases.json" "$ASSET" >"$TMP/candidates" || true
		line="$(tail -n 1 "$TMP/candidates")"
		[ -n "$line" ] || die "no release carries a ${ASSET} binary yet (see https://github.com/${REPO}/releases)"
		VERSION="${line%% *}"
	else
		list_status="${FETCH_STATUS:-none}"
		case "$list_status" in
			403 | 429) say "GitHub API rate limited; using the releases page (${SITE}/latest)." ;;
			*) say "GitHub API did not answer (status ${list_status}); using the releases page (${SITE}/latest)." ;;
		esac
		latest_from_site || die "could not read the release list at ${RELEASES_URL} (last status: ${list_status}), and the releases page fallback failed: ${LATEST_WHY}. Set EIGHT_VERSION=X.Y.Z to install a release by name"
		NOAPI=1
	fi
	TAG="v${VERSION}"

	if [ "$NPM_PATH" = 1 ]; then
		# Termux installs the release's npm package, not the binary.
		ASSET="8gi-foundation-8gent-code-${VERSION}.tgz"
	fi
	if ! release_asset "$ASSET"; then
		if [ -n "$WANT" ]; then
			die "release v${WANT} has no ${ASSET} (see https://github.com/${REPO}/releases)"
		elif [ "$NOAPI" = 1 ]; then
			die "the newest release v${VERSION} has no ${ASSET}; set EIGHT_VERSION=X.Y.Z to install a release that has one (see https://github.com/${REPO}/releases)"
		else
			die "release v${VERSION} has no ${ASSET} (see https://github.com/${REPO}/releases)"
		fi
	fi
	URL="$AURL"

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

	release_asset SHA256SUMS || die "release v${VERSION} has no SHA256SUMS; refusing an unverified binary"
	SUMS_URL="$AURL"
	fetch "$SUMS_URL" "$TMP/SHA256SUMS" asset || die "could not download SHA256SUMS for v${VERSION}"

	if [ -n "$KEY" ]; then
		release_asset SHA256SUMS.minisig || die "release v${VERSION} has no SHA256SUMS.minisig; refusing unsigned checksums"
		SIG_URL="$AURL"
		fetch "$SIG_URL" "$TMP/SHA256SUMS.minisig" asset || die "could not download SHA256SUMS.minisig for v${VERSION}"
		find_minisign
		if [ -n "$MS_BIN" ]; then
			"$MS_BIN" -q -V -m "$TMP/SHA256SUMS" -x "$TMP/SHA256SUMS.minisig" -P "$KEY" >/dev/null 2>&1 ||
				die "SHA256SUMS for v${VERSION} does not carry a valid release signature; nothing installed"
			say "Release signature on SHA256SUMS: verified."
		elif [ "${EIGHT_ALLOW_UNVERIFIED:-}" = 1 ]; then
			warn "the release signature was NOT checked (no minisign for this machine), as EIGHT_ALLOW_UNVERIFIED=1 asked."
		else
			die "cannot check the release signature: install minisign (https://jedisct1.github.io/minisign/) and run this again, or set EIGHT_ALLOW_UNVERIFIED=1 to skip it"
		fi
	else
		if [ "$NPM_PATH" = 1 ]; then
			warn "this release has no signing key yet; only the SHA256 checksum of the package is checked (no GitHub attestation covers the npm package)."
		else
			warn "this release has no signing key yet; only the SHA256 checksum (and the GitHub attestation, if gh is signed in) is checked."
		fi
	fi

	say "Downloading 8gent v${VERSION} (${ASSET})..."
	fetch "$URL" "$TMP/$ASSET" asset || die "download failed: ${URL}"
	expected="$(awk -v f="$ASSET" '$2 == f || $2 == "*" f {print $1}' "$TMP/SHA256SUMS" | head -n 1)"
	[ -n "$expected" ] || die "SHA256SUMS for v${VERSION} does not list ${ASSET}; refusing an unverified binary"
	actual="$(sha256_of "$TMP/$ASSET")"
	[ "$expected" = "$actual" ] || die "checksum mismatch for ${ASSET} (expected ${expected}, got ${actual}); nothing installed"

	if [ "$NPM_PATH" = 1 ]; then
		ensure_node
		say "Installing 8gent v${VERSION} with npm (its dependencies come from the npm registry, as with npm install -g; no install scripts are run)..."
		npm i -g --ignore-scripts "$TMP/$ASSET" || die "npm could not install ${ASSET}; nothing else was changed"
		say "Installed 8gent v${VERSION} (npm package, Termux). 8gent is ready. Run: 8gent"
		return 0
	fi

	if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
		# No --source-ref: gh before 2.64 does not have it. Ask for JSON and check
		# the verified source ref here instead, so the check is no weaker.
		if ! gh attestation verify "$TMP/$ASSET" --repo "$REPO" \
			--signer-workflow "${REPO}/.github/workflows/release-binaries.yml" \
			--format json >"$TMP/attestation.json" 2>"$TMP/attestation.err"; then
			if grep -qiE 'unknown (flag|command)' "$TMP/attestation.err"; then
				die "the GitHub CLI on this machine ($(gh --version 2>/dev/null | head -n 1)) cannot verify build attestations the way this installer needs; no verification was run and nothing installed. Upgrade it (brew upgrade gh, or your package manager) and run this again"
			fi
			die "GitHub build attestation for ${ASSET} v${VERSION} did not verify; nothing installed. gh said: $(head -c 2000 "$TMP/attestation.err")"
		fi
		# Every appearance of sourceRepositoryRef in the verified output must be
		# exactly this tag. Count rather than capture: $(...) drops trailing empty
		# lines, so an empty or non-string ref could otherwise vanish.
		seen="$(grep -o '"sourceRepositoryRef"' "$TMP/attestation.json" | wc -l | tr -d ' ')"
		exact="$(grep -o '"sourceRepositoryRef" *: *"[^"]*"' "$TMP/attestation.json" | sed 's/.*: *"\([^"]*\)"/\1/' | grep -cxF "refs/tags/${TAG}" || true)"
		[ "$seen" -gt 0 ] || die "gh verified ${ASSET} but reported no source ref; refusing to trust it; nothing installed"
		if [ "$exact" != "$seen" ]; then
			die "GitHub build attestation for ${ASSET} was built from $(grep -o '"sourceRepositoryRef" *: *[^,}]*' "$TMP/attestation.json" | grep -vF "\"refs/tags/${TAG}\"" | head -n 1), not refs/tags/${TAG}; nothing installed"
		fi
		say "GitHub build attestation: verified."
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
