#!/usr/bin/env bash
# Fail if any commit introduced by a change is attributed to an AI vendor:
#   - author or committer identity (name or email) names a vendor, or
#   - a Co-Authored-By / Claude-Session / "Generated with" trailer names a vendor.
# Prose that merely mentions a vendor passes: identity, not discussion.
#
# Range: ONLY the change's own commits.
#   pull_request : merge-base(BASE_SHA, HEAD)..HEAD, BASE_SHA being the PR base
#                  sha from the event (github.event.pull_request.base.sha).
#                  Never origin/main of a stale or shallow checkout: that range
#                  also holds main commits already merged by someone else
#                  (false positive on 8gent-dev #126).
#   push         : BEFORE_SHA..HEAD (falls back to HEAD~1..HEAD)
# Env: BASE_SHA, BEFORE_SHA, HEAD_SHA (default HEAD).
set -uo pipefail

HEAD_REF="${HEAD_SHA:-HEAD}"
ZERO=0000000000000000000000000000000000000000

have() { git cat-file -e "$1^{commit}" 2>/dev/null; }

# Make sure the base is present and shares history with HEAD, deepening a
# shallow checkout until a merge-base exists.
ensure_base() {
  local base="$1" depth=200 mb
  have "$base" || git fetch -q --no-tags origin "$base" 2>/dev/null || true
  while :; do
    mb="$(git merge-base "$base" "$HEAD_REF" 2>/dev/null || true)"
    [ -n "$mb" ] && { printf '%s' "$mb"; return 0; }
    if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
      git fetch -q --no-tags --deepen="$depth" origin 2>/dev/null \
        || git fetch -q --no-tags --unshallow origin 2>/dev/null || return 1
      depth=$((depth * 4))
      [ "$depth" -gt 100000 ] && return 1
    else
      return 1
    fi
  done
}

if [ -n "${BASE_SHA:-}" ] && [ "$BASE_SHA" != "$ZERO" ]; then
  if MB="$(ensure_base "$BASE_SHA")"; then
    RANGE="${MB}..${HEAD_REF}"
  else
    echo "::error::cannot find a merge base between ${BASE_SHA} and ${HEAD_REF}; refusing to guess a range"
    exit 2
  fi
elif [ -n "${BEFORE_SHA:-}" ] && [ "$BEFORE_SHA" != "$ZERO" ] && have "$BEFORE_SHA"; then
  RANGE="${BEFORE_SHA}..${HEAD_REF}"
else
  RANGE="${HEAD_REF}~1..${HEAD_REF}"
fi

VENDOR='claude|anthropic|openai|chatgpt|copilot|codex|gemini'
BAD=0

while IFS= read -r sha; do
  [ -z "$sha" ] && continue
  why=""
  who="$(git show -s --format='%an <%ae>%n%cn <%ce>' "$sha")"
  if printf '%s\n' "$who" | grep -Eiq "$VENDOR"; then
    why="author or committer is an AI vendor identity"
  fi
  body="$(git show -s --format='%B' "$sha")"
  if printf '%s\n' "$body" | grep -Eiq "^[[:space:]]*co-authored-by:[^<]*(${VENDOR})[^<]*<|^[[:space:]]*co-authored-by:.*<[^>]*(${VENDOR})[^>]*>"; then
    why="Co-Authored-By trailer names an AI vendor"
  elif printf '%s\n' "$body" | grep -Eiq '^[[:space:]]*claude-session[[:space:]]*:'; then
    why="Claude-Session trailer"
  elif printf '%s\n' "$body" | grep -Eiq "^[[:space:]]*[^[:alnum:][:space:]]*[[:space:]]*generated (with|by)\b.*(${VENDOR})"; then
    why="\"Generated with\" trailer names an AI vendor"
  fi
  if [ -n "$why" ]; then
    echo "::error::Commit $sha: $why."
    git show -s --format='  author:    %an <%ae>%n  committer: %cn <%ce>%n  subject:   %s' "$sha"
    BAD=1
  fi
done < <(git rev-list "$RANGE" 2>/dev/null)

if [ "$BAD" -ne 0 ]; then
  echo ""
  echo "No AI vendor may appear as author, committer or trailer (AGENTS.md prohibition 4)."
  echo "Set a real identity and remove the trailer, then amend or rebase your own commits:"
  echo "  git config user.name  \"James Spalding\""
  echo "  git config user.email \"podjamz@gmail.com\""
  exit 1
fi
echo "authorship clean over $RANGE"
