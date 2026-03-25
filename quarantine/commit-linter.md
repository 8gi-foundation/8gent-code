# Quarantine: Conventional Commit Linter

**Status:** Quarantine - awaiting review before wiring into CI or hooks
**Package:** `packages/validation/commit-linter.ts`
**Branch:** `quarantine/commit-linter`

---

## What it does

`lintCommit(message: string): LintResult` validates a git commit message against:

1. **Conventional commit format** - `type(scope)!: description` header required
2. **Allowed types** - feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert
3. **Subject line length** - hard error above 72 chars, warning above 60
4. **Em dash detection** - hard error on U+2014, U+2013, U+FE58, U+FE31 (all banned in this repo)
5. **Description quality** - no empty descriptions, no vague terms, no trailing periods, no leading capitals
6. **Scope format** - lowercase kebab-case when provided
7. **Blank line separator** - enforced between header and body
8. **Body line length** - warning above 100 chars per line
9. **Breaking change footer** - warns if `!` used without `BREAKING CHANGE:` footer
10. **Quality score** - 0-100 (100 - 20 per error - 5 per warning)

---

## API

```typescript
import { lintCommit } from "./packages/validation/commit-linter.ts";

const result = lintCommit("feat(auth): add JWT refresh token rotation");
// {
//   valid: true,
//   score: 100,
//   errors: [],
//   warnings: [],
//   parsed: { type: "feat", scope: "auth", breaking: false, description: "add JWT refresh token rotation", body: null, footer: null }
// }
```

### LintResult shape

| Field | Type | Description |
|-------|------|-------------|
| `valid` | `boolean` | true when errors array is empty |
| `score` | `number` | 0-100 quality score |
| `errors` | `string[]` | blocking issues (exit 1 in CI) |
| `warnings` | `string[]` | non-blocking style issues |
| `parsed` | `ParsedCommit \| null` | structured breakdown of the message |

---

## CLI

```bash
# Pass - 100/100
bun packages/validation/commit-linter.ts "feat(auth): add JWT refresh"

# Fail - em dash banned
bun packages/validation/commit-linter.ts $'feat: add auth \u2014 fixes login redirect'

# Fail - unknown type
bun packages/validation/commit-linter.ts "update: something"

# Fail - too vague
bun packages/validation/commit-linter.ts "chore: stuff"
```

Exit code 0 = valid, exit code 1 = errors found.

---

## Next steps (before wiring)

- [ ] Add as git `commit-msg` hook via a hooks manager
- [ ] Wire into CI pipeline (`.github/workflows/`) as a lint step on PR
- [ ] Consider adding to `packages/validation/index.ts` exports
- [ ] Evaluate: auto-suggest fixes for common errors (type correction, length trimming)

---

## Zero deps

No external packages. Uses only built-in JS string operations and regex. Safe to import anywhere in the monorepo.
