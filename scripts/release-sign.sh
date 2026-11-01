#!/usr/bin/env bash
# release-sign.sh - sign a release's SHA256SUMS with the release key (#3981).
#
#   release-sign.sh <SHA256SUMS> <tag>
#
# Writes <SHA256SUMS>.minisig next to it and verifies it against the public
# key in scripts/release-signing.pub, the key the installers and self-update
# embed, so a secret that does not match what clients trust fails here.
#
#   MINISIGN_SECRET_KEY set              sign, then verify          -> exit 0
#   unset, release-signing.pub empty     no release key yet: notice -> exit 0, unsigned
#   unset, release-signing.pub has a key clients would refuse       -> exit 1
#
# MINISIGN overrides the minisign binary. The secret key only ever lives in a
# 0600 file under a private temp dir, removed on exit.
set -euo pipefail

MINISIGN="${MINISIGN:-minisign}"
SUMS="${1:?SHA256SUMS path}"
TAG="${2:?tag}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PUB="$(grep -v '^#' "$HERE/release-signing.pub" | tr -d '[:space:]')"

if [ -z "${MINISIGN_SECRET_KEY:-}" ]; then
	if [ -n "$PUB" ]; then
		echo "::error::scripts/release-signing.pub holds a release key but the MINISIGN_SECRET_KEY secret is not set; installers would refuse this release's unsigned SHA256SUMS." >&2
		exit 1
	fi
	echo "::notice::no release signing key yet (scripts/release-signing.pub is empty); ${TAG} ships unsigned SHA256SUMS."
	exit 0
fi
if [ -z "$PUB" ]; then
	echo "::error::MINISIGN_SECRET_KEY is set but scripts/release-signing.pub is empty; add the public key there (and to the installers and self-update) first." >&2
	exit 1
fi

dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
umask 077
printf '%s\n' "$MINISIGN_SECRET_KEY" > "$dir/release.key"
"$MINISIGN" -S -s "$dir/release.key" -m "$SUMS" -x "$SUMS.minisig" -t "8gent ${TAG} SHA256SUMS" </dev/null
"$MINISIGN" -V -q -m "$SUMS" -x "$SUMS.minisig" -P "$PUB"
echo "signed ${SUMS} for ${TAG}; signature verifies against scripts/release-signing.pub"
