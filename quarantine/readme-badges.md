# Quarantine: README Badge Generator

## Problem

README badges go stale. Package counts, benchmark categories, tool counts, and version numbers drift from reality.

## Solution

`scripts/generate-badges.ts` scans the repo and generates shields.io badge URLs with live counts.

## What it counts

| Metric | Source |
|--------|--------|
| Version | `package.json` version field |
| Packages | Directory count in `packages/` |
| Benchmarks | Directory count in `benchmarks/categories/` |
| Tools | `name:` declarations in `packages/eight/tools.ts` |
| Skills | Directory count in `packages/skills/` |
| License | `package.json` license field |

## Usage

```bash
# Human-readable output with markdown badge row
bun run scripts/generate-badges.ts

# JSON output for CI pipelines
bun run scripts/generate-badges.ts --json
```

## CI integration

Add to a GitHub Action to auto-update badges on push to main:

```yaml
- name: Generate badges
  run: bun run scripts/generate-badges.ts --json > .8gent/badges.json
```

## Graduation criteria

- Verify badge counts match repo reality
- Wire into CI pipeline
- Confirm shields.io URLs render correctly in GitHub markdown
