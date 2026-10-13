#!/usr/bin/env bash
# release-require-draft.sh - refuse to change the files of a published release (#3981).
#
# Release workflows upload with --clobber so a re-run can repair its own
# draft. On a release that is already public, --clobber would silently swap
# the files people are installing. This exits 0 only when TAG is a draft, or
# (with --allow-missing) does not exist yet.
#
#   release-require-draft.sh <tag> [--allow-missing]
#
# Needs GH_TOKEN; REPO (owner/repo) is optional. GH overrides the gh binary.
set -euo pipefail

GH="${GH:-gh}"
TAG="${1:?tag}"
ALLOW_MISSING="${2:-}"
repo_args=()
if [ -n "${REPO:-}" ]; then repo_args=(--repo "$REPO"); fi

if ! state="$("$GH" release view "$TAG" ${repo_args[@]+"${repo_args[@]}"} --json isDraft --jq .isDraft 2>/dev/null)"; then
	if [ "$ALLOW_MISSING" = "--allow-missing" ]; then
		echo "release ${TAG} does not exist yet"
		exit 0
	fi
	echo "::error::release ${TAG} does not exist" >&2
	exit 1
fi
if [ "$state" != "true" ]; then
	echo "::error::release ${TAG} is already published; refusing to replace its files. Cut a new version instead." >&2
	exit 1
fi
echo "release ${TAG} is a draft"
