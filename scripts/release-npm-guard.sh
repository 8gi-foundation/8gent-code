#!/usr/bin/env bash
# release-npm-guard.sh VERSION TAG - fail loudly when VERSION is already on npm
# but this repo has no release for TAG. That state means the number was
# published from another tree (the private archive published 0.20.42); tagging
# it here would make one version mean two builds, and the npm step would skip
# the publish without a word. A re-run of a release that this repo already
# started (a draft or published release for TAG exists) passes.
#
# Test seams: NPM_PUBLISHED_VERSION (what `npm view` returns) and
# RELEASE_EXISTS (1/0) replace the network calls.
set -euo pipefail
version="${1:?version}"
tag="${2:?tag}"
if [ -n "${NPM_PUBLISHED_VERSION+x}" ]; then
	onnpm="$NPM_PUBLISHED_VERSION"
else
	onnpm="$(npm view "@8gi-foundation/8gent-code@${version}" version 2>/dev/null || true)"
fi
[ "$onnpm" = "$version" ] || exit 0
if [ -n "${RELEASE_EXISTS+x}" ]; then
	exists="$RELEASE_EXISTS"
elif gh release view "$tag" >/dev/null 2>&1; then
	exists=1
else
	exists=0
fi
[ "$exists" = 1 ] && exit 0
echo "::error::@8gi-foundation/8gent-code@${version} is already on npm but this repo has no release for ${tag}. It was published from another tree; releasing ${tag} here would give one version two builds. Bump to an unused version." >&2
exit 1
