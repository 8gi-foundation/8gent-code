# PR Auto-Labeler

**Status:** quarantine - ready for review
**Package:** `packages/proactive/pr-labeler.ts`
**Lines:** ~120

## Problem

PRs lack consistent labels, making triage slow. Manual labeling is forgotten or inconsistent.

## What it does

Reads the file list of a GitHub PR and applies two kinds of labels automatically:

### Path labels

| File prefix | Label |
|-------------|-------|
| `apps/` | `app` |
| `packages/` | `package` |
| `benchmarks/` | `benchmark` |
| `docs/` | `docs` |
| `quarantine/` | `quarantine` |

A single PR can receive multiple path labels if it touches files in several directories.

### Size labels

| Changed lines | Label |
|---------------|-------|
| < 100 | `size/small` |
| 100 - 500 | `size/medium` |
| > 500 | `size/large` |

## Usage

### CLI

```bash
GITHUB_TOKEN=xxx bun run packages/proactive/pr-labeler.ts owner/repo 42
GITHUB_TOKEN=xxx bun run packages/proactive/pr-labeler.ts owner/repo 42 --dry-run
```

### GitHub Action

```yaml
name: PR Labeler
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  label:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run packages/proactive/pr-labeler.ts
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
```

### Programmatic

```typescript
import { deriveLabels, labelPR } from "./packages/proactive/pr-labeler.ts";

// Pure function - no API calls
const result = deriveLabels([
  { filename: "apps/tui/src/app.tsx", additions: 10, deletions: 5, changes: 15 },
  { filename: "packages/memory/store.ts", additions: 40, deletions: 20, changes: 60 },
]);
// result.all_labels = ["app", "package", "size/small"]

// Full flow - fetches diff, applies labels
await labelPR("owner/repo", 42, token);
```

## Design decisions

- Pure `deriveLabels()` function separated from API calls for easy testing
- No dependencies beyond `fetch` (built into Bun)
- Env vars (`GITHUB_REPOSITORY`, `PR_NUMBER`) match GitHub Actions defaults for zero-config in CI
- Dry-run mode for safe local testing

## Graduation criteria

- [ ] Run on 5+ real PRs without false labels
- [ ] Add unit tests for `deriveLabels()`
- [ ] Wire into CI as a GitHub Action
