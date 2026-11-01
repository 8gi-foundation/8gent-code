#!/usr/bin/env bash
# Bulk-add claw-code / harness roadmap issues to a GitHub Project (Projects v2).
# Requires: gh auth refresh -s project
#
# Usage:
#   export GITHUB_PROJECT_NUMBER=<n>   # required; from: gh project list --owner 8gi-foundation
#   ./scripts/gh-project-roadmap.sh
#
# Optional env:
#   GITHUB_PROJECT_OWNER (default: 8gi-foundation)
#   GITHUB_REPO          (default: 8gi-foundation/8gent-code)

set -euo pipefail

OWNER="${GITHUB_PROJECT_OWNER:-8gi-foundation}"
REPO="${GITHUB_REPO:-8gi-foundation/8gent-code}"
NUM="${GITHUB_PROJECT_NUMBER:?Set GITHUB_PROJECT_NUMBER (project number from gh project list --owner "${OWNER}")}"

ISSUES=(
  1076
  1077 1078 1079 1080 1081 1082 1083 1084 1085 1086 1087 1088
  1089 1090 1091 1092 1093
)

echo "Adding ${#ISSUES[@]} issues to project #${NUM} (${OWNER})..."
for i in "${ISSUES[@]}"; do
  url="https://github.com/${REPO}/issues/${i}"
  echo "  + ${url}"
  gh project item-add "${NUM}" --owner "${OWNER}" --url "${url}"
done
echo "Done."
