# schema-migration

## Tool Name
`schema-migration` (`MigrationRunner`)

## Description
Manages database schema migrations with ordered versioning, up/down support, rollback by steps or target version, dry run mode, and a single-row lock table to prevent concurrent migration runs. Designed to wrap any `MigrationDB` adapter (SQLite, Postgres, etc.) without introducing external dependencies.

## Status
**quarantine** - implemented, not yet wired into the agent or any package index.

## Location
`packages/tools/schema-migration.ts`

## Integration Path
1. Import `MigrationRunner` and `Migration` from `packages/tools/schema-migration.ts`.
2. Provide a `MigrationDB` adapter that wraps the target database (e.g. `bun:sqlite`'s `Database`).
3. Register migrations via `runner.registerAll([...])`.
4. Call `runner.run()` at agent startup or as a CLI command (`bun run migrate`).
5. Wire `runner.rollback()` into a `/rollback` CLI command or admin route.
6. Candidate consumers: `packages/memory/store.ts` (SQLite), daemon Postgres schema, kernel training DB.
