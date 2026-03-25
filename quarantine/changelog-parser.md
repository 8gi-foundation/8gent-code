# changelog-parser

## Tool Name
`changelog-parser`

## Description
Parses Keep a Changelog (https://keepachangelog.com/) markdown format into structured version entries. Supports:
- Extracting versions, dates, and YANKED flags
- Categorised entries (Added, Changed, Deprecated, Removed, Fixed, Security)
- Querying a semver version range (inclusive)
- Adding new entries to an Unreleased section
- Serialising a parsed changelog back to markdown

## Status
`quarantine`

Placed in quarantine for review before wiring into the agent tool registry. No integration yet - exports are stable but the API surface should be validated against real-world changelogs before promotion.

## Location
`packages/tools/changelog-parser.ts`

## Exports
| Export | Signature | Purpose |
|--------|-----------|---------|
| `parseChangelog` | `(md: string) => Changelog` | Parse markdown to structured object |
| `addEntry` | `(changelog, entry) => Changelog` | Add entry to Unreleased section |
| `queryVersionRange` | `(changelog, from, to) => VersionEntry[]` | Filter versions by semver range |
| `serializeChangelog` | `(changelog) => string` | Round-trip back to markdown |

## Integration Path
1. Export from `packages/tools/index.ts` once promoted from quarantine
2. Register in `packages/eight/tools.ts` as a `read_changelog` / `update_changelog` tool pair
3. Inject into agent context so Eight can read and update `CHANGELOG.md` during release flows

## Dependencies
None. Pure TypeScript, no external imports.
