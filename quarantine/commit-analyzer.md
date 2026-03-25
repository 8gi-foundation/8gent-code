# Quarantine: Commit Analyzer

**Package:** `packages/validation/commit-analyzer.ts`
**Status:** Quarantined - not yet exported from package index
**Lines:** ~130

## What it does

Analyzes git commit messages for Conventional Commits (v1.0.0) compliance.

### Features

- Parses header into type, scope, description
- Detects breaking changes (! suffix and BREAKING CHANGE footer)
- Extracts body and footers
- Quality score 0-100 based on: valid type, scope presence, description length, lowercase start, no trailing period, body presence
- Batch analysis with compliance percentage and type distribution

### API

```ts
import { analyzeCommit, analyzeCommits } from "./packages/validation/commit-analyzer";

const result = analyzeCommit("feat(memory): add contradiction detection");
// { valid: true, type: "feat", scope: "memory", quality: 95, ... }

const batch = analyzeCommits(["fix: typo", "bad message", "feat!: breaking thing"]);
// { compliance: 66, averageQuality: 48, typeDistribution: { fix: 1, feat: 1 } }
```

### Promotion criteria

- [ ] Unit tests covering edge cases (empty, multi-line, footers, breaking)
- [ ] Wire into pre-commit or CI lint step
- [ ] Export from `packages/validation/index.ts`
