# Quarantine: release-notes

## What

`packages/proactive/release-notes.ts` - generates user-friendly release notes from git log and PR titles.

## Why

The existing `changelog-gen.ts` produces Keep a Changelog formatted output aimed at developers. This module produces polished, emoji-prefixed release notes grouped by feature/fix/docs/improvements, with contributor mentions - suitable for GitHub Releases, Discord announcements, or user-facing changelogs.

## How it works

1. Reads git log since a tag or date (same CLI interface as changelog-gen)
2. Parses conventional commit prefixes to classify into 5 groups: features, fixes, docs, improvements, other
3. Strips commit prefixes for readability, adds PR links and commit hash links
4. Collects unique contributors from commit authors
5. Renders markdown with emoji section headers and a contributors section

## Usage

```bash
bun run packages/proactive/release-notes.ts --since v1.0.0
bun run packages/proactive/release-notes.ts --since 2026-03-01
bun run packages/proactive/release-notes.ts  # since last tag
```

## Scope

- 1 new file: `packages/proactive/release-notes.ts` (~130 lines of logic)
- 0 existing files modified
- No new dependencies

## Exit criteria

- [ ] Runs without errors against real git history
- [ ] Groups commits correctly by conventional-commit type
- [ ] PR links and contributor mentions render as valid markdown
- [ ] Output is suitable for pasting into a GitHub Release
