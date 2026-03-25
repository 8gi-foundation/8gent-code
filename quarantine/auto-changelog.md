# Quarantine: Auto Changelog Generator

## What

`packages/proactive/changelog-gen.ts` - automatic changelog generator that reads git log, groups by conventional commit type, and outputs Keep a Changelog formatted entries.

## Status

Quarantined - new utility, no existing files modified.

## Usage

```bash
# Since a specific tag
bun run packages/proactive/changelog-gen.ts --since v1.0.0

# Since a date
bun run packages/proactive/changelog-gen.ts --since 2026-03-01

# Since last tag (auto-detected)
bun run packages/proactive/changelog-gen.ts
```

Output goes to stdout. Pipe to file or append to CHANGELOG.md:

```bash
bun run packages/proactive/changelog-gen.ts --since v1.0.0 > changelog-entry.md
```

## Features

- Groups commits: Added, Fixed, Changed, Documentation, Removed, Other
- Detects breaking changes (! suffix or BREAKING CHANGE in body)
- Extracts and links PR numbers
- Links commit hashes to GitHub
- Keep a Changelog format
- ~130 lines, zero dependencies beyond Bun

## Files

| File | Lines | Purpose |
|------|-------|---------|
| `packages/proactive/changelog-gen.ts` | ~130 | Generator script |
| `quarantine/auto-changelog.md` | this file | Quarantine doc |

## Graduation criteria

- [ ] Tested on real git history
- [ ] Output reviewed for accuracy
- [ ] Integrated into release workflow
