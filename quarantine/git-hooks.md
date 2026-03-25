# Quarantine: Git Hooks

**Status:** Quarantine - not yet integrated into CI or onboarding
**Script:** `scripts/install-hooks.ts`

## What This Adds

Three local git hooks installed via a single Bun script:

| Hook | Purpose | Blocking? |
|------|---------|-----------|
| `pre-commit` | Lint staged `.ts/.tsx` files + scan diffs for leaked secrets | Yes |
| `commit-msg` | Enforce conventional commit format (`type(scope): description`) | Yes |
| `post-commit` | Fire-and-forget code review trigger (calls `scripts/review-commit.ts` if present) | No |

## Installation

```bash
bun run scripts/install-hooks.ts
```

Hooks are written to `.git/hooks/` with 755 permissions. Re-running overwrites existing hooks.

## Hook Details

### pre-commit

1. Collects staged `.ts/.tsx` files.
2. Runs `tsc --noEmit` if `tsconfig.json` exists.
3. Scans staged diffs for secret patterns (private keys, `sk-*`, `ghp_*`, password assignments).
4. Bypass secret scan with `SKIP_SECRET_SCAN=1 git commit`.

### commit-msg

Validates the first line against conventional commit format:

```
type(optional-scope): description
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.

### post-commit

Non-blocking. If `scripts/review-commit.ts` exists, spawns it in the background with the short commit hash. Otherwise logs a skip message. Never fails the commit.

## Graduation Criteria

Move out of quarantine when:

- [ ] Tested on at least 20 real commits without false positives
- [ ] Secret scan patterns validated against known leak formats
- [ ] `scripts/review-commit.ts` exists and produces useful output
- [ ] Added to `bun install` postinstall or onboarding flow

## Risks

- `tsc --noEmit` can be slow on the full monorepo - may need scoping to changed packages only
- Secret scan regex is basic - consider switching to `trufflehog` or `gitleaks` for production use
- Conventional commit enforcement may frustrate contributors unfamiliar with the format
