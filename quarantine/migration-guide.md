# Quarantine: Migration Guide

## What

`docs/MIGRATION.md` - a guide for developers migrating from other coding agents (Claude Code, Cursor, Aider, Codex) to 8gent Code. Covers feature comparison, migration steps per tool, and how to run 8gent as an overlay alongside existing tools.

## Status

Quarantined - new documentation only, no existing files modified.

## Files Added

| File | Purpose |
|------|---------|
| `docs/MIGRATION.md` | Full migration guide (~180 lines) |
| `quarantine/migration-guide.md` | This quarantine record |

## Sections

- Feature comparison table (8gent vs Claude Code vs Cursor vs Aider vs Codex)
- Per-tool migration: what's different, what you'll miss, migration steps
- Overlay mode: running 8gent alongside other tools
- Common questions (API keys, Windows, model sizes, permissions, data storage)

## Review Notes

- Claims are grounded in actual 8gent capabilities documented in CLAUDE.md and package READMEs
- No stat padding - only states features that exist in the codebase
- Feature comparison is honest about trade-offs (what you'll miss from each tool)
- No em dashes used
