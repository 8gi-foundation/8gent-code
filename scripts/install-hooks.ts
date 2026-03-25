#!/usr/bin/env bun
/**
 * install-hooks.ts - Install git hooks for 8gent-code
 *
 * Installs three hooks:
 *   pre-commit  - lint staged files + secret scan
 *   commit-msg  - enforce conventional commit format
 *   post-commit - trigger async code review
 *
 * Usage: bun run scripts/install-hooks.ts
 */

import { writeFileSync, chmodSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const gitRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
const hooksDir = join(gitRoot, ".git", "hooks");

if (!existsSync(hooksDir)) {
  mkdirSync(hooksDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// pre-commit: lint staged .ts/.tsx files + scan for secrets
// ---------------------------------------------------------------------------
const preCommit = `#!/usr/bin/env bash
set -euo pipefail

# Lint staged TypeScript files
STAGED=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\\.(ts|tsx)$' || true)

if [ -n "$STAGED" ]; then
  echo "[pre-commit] Checking $(echo "$STAGED" | wc -l | tr -d ' ') staged file(s)..."

  # Type-check if tsconfig exists
  if [ -f "tsconfig.json" ]; then
    npx --no-install tsc --noEmit 2>/dev/null || {
      echo "[pre-commit] TypeScript errors found. Fix before committing."
      exit 1
    }
  fi
fi

# Secret scan - block commits containing likely secrets
PATTERNS='(PRIVATE.KEY|sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|password\\s*=\\s*["\x27].{8,})'
SECRETS=$(git diff --cached --diff-filter=ACM -U0 | grep -E "^\\+" | grep -iE "$PATTERNS" || true)

if [ -n "$SECRETS" ]; then
  echo "[pre-commit] Possible secrets detected in staged changes:"
  echo "$SECRETS"
  echo ""
  echo "Remove secrets before committing, or use SKIP_SECRET_SCAN=1 git commit"
  [ "\${SKIP_SECRET_SCAN:-}" = "1" ] && exit 0
  exit 1
fi

echo "[pre-commit] OK"
`;

// ---------------------------------------------------------------------------
// commit-msg: enforce conventional commits (type(scope): description)
// ---------------------------------------------------------------------------
const commitMsg = `#!/usr/bin/env bash
set -euo pipefail

MSG_FILE="$1"
MSG=$(head -1 "$MSG_FILE")

# Conventional commit pattern: type(optional-scope): description
# Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert
PATTERN='^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\\([a-z0-9_-]+\\))?!?: .{1,}'

if ! echo "$MSG" | grep -qE "$PATTERN"; then
  echo "[commit-msg] Invalid commit message format."
  echo ""
  echo "Expected: type(scope): description"
  echo "Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert"
  echo ""
  echo "Examples:"
  echo "  feat(memory): add contradiction detection"
  echo "  fix: resolve agent abort race condition"
  echo "  docs: update HYPERAGENT-SPEC"
  echo ""
  echo "Your message: $MSG"
  exit 1
fi

echo "[commit-msg] OK"
`;

// ---------------------------------------------------------------------------
// post-commit: fire-and-forget code review trigger
// ---------------------------------------------------------------------------
const postCommit = `#!/usr/bin/env bash
# post-commit: trigger async code review (non-blocking)
# Failures here never block the developer workflow.

COMMIT=$(git rev-parse --short HEAD)
BRANCH=$(git branch --show-current)

echo "[post-commit] Commit $COMMIT on $BRANCH"

# If a review script exists, run it in the background
REVIEW_SCRIPT="scripts/review-commit.ts"
if [ -f "$REVIEW_SCRIPT" ]; then
  nohup bun run "$REVIEW_SCRIPT" "$COMMIT" > /dev/null 2>&1 &
  echo "[post-commit] Code review queued for $COMMIT"
else
  echo "[post-commit] No review script found - skipping automated review"
fi
`;

// ---------------------------------------------------------------------------
// Install all hooks
// ---------------------------------------------------------------------------
const hooks: Array<[string, string]> = [
  ["pre-commit", preCommit],
  ["commit-msg", commitMsg],
  ["post-commit", postCommit],
];

for (const [name, content] of hooks) {
  const hookPath = join(hooksDir, name);
  writeFileSync(hookPath, content, "utf-8");
  chmodSync(hookPath, 0o755);
  console.log(`Installed ${name} -> ${hookPath}`);
}

console.log(`\nAll ${hooks.length} hooks installed.`);
