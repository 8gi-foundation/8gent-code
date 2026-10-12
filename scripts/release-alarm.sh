#!/usr/bin/env bash
# release-alarm.sh - make a failed release run visible (#3658, #3981).
#
# From 1 to 8 Oct 2026 every release run failed and nobody noticed, because
# people watch issues and PR checks, not post-merge workflow runs. The release
# workflows call this from a `failure()` job: it opens one P0 issue per
# workflow and ref, or comments on the open one, with the run link.
#
#   release-alarm.sh <workflow-file> <ref> <run-url>
#
# Needs GH_TOKEN (issues: write) and REPO (owner/repo). GH overrides the gh
# binary. Arguments only ever reach gh as separate argv entries, never shell source.
set -euo pipefail

GH="${GH:-gh}"
WORKFLOW="${1:?workflow file}"
REF="${2:?ref}"
RUN_URL="${3:?run url}"
: "${REPO:?REPO=owner/repo}"

TITLE="Release failed: ${WORKFLOW} on ${REF}"
BODY="${WORKFLOW} failed on ${REF}: ${RUN_URL}

Until this is fixed and the run is re-run, the GitHub Release is not published and the one-line installers keep serving the previous version."

N=""
while IFS=$'\t' read -r num title; do
	if [ "$title" = "$TITLE" ]; then N="$num"; break; fi
done < <("$GH" issue list --repo "$REPO" --state open --search "\"${TITLE}\" in:title" \
	--json number,title --jq '.[] | "\(.number)\t\(.title)"')
if [ -n "$N" ]; then
	"$GH" issue comment "$N" --repo "$REPO" --body "$BODY"
	echo "commented on #${N}: ${TITLE}"
else
	"$GH" issue create --repo "$REPO" --title "$TITLE" --body "$BODY" --label P0 \
		|| "$GH" issue create --repo "$REPO" --title "$TITLE" --body "$BODY"
	echo "opened: ${TITLE}"
fi
