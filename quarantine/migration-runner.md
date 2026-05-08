# Quarantine: migration-runner

**Package:** `packages/tools/migration-runner.ts`
**Status:** Quarantine - pending integration review

## What it does

Runs versioned data migrations in order with rollback, pending detection, and history tracking. Tracks applied migrations in a JSON state file (default: `.8gent/migrations.json`).

## API

```ts
import { MigrationRunner } from "./packages/tools/migration-runner";

const runner = new MigrationRunner(".8gent/migrations.json");

// Register migrations (version, up, down?)
runner.register("001", async () => { /* up */ }, async () => { /* down */ }, "init schema");
runner.register("002", async () => { /* up */ }); // down is optional

// Run all pending migrations (or up to a target version)
const result = await runner.migrate();          // { ran: ["001", "002"], skipped: 0 }
await runner.migrate("001");                    // only up to version 001

// Rollback last N steps (default: 1)
const rolled = await runner.rollback();         // { reverted: ["002"] }
await runner.rollback(2);                       // revert last 2

// Inspect state
runner.current();   // "002" - last applied version, or null
runner.pending();   // Migration[] not yet applied
runner.history();   // MigrationRecord[] - version, appliedAt, description
```

## State file format

```json
{
  "applied": [
    { "version": "001", "appliedAt": "2026-03-25T12:00:00.000Z", "description": "init schema" },
    { "version": "002", "appliedAt": "2026-03-25T12:01:00.000Z" }
  ]
}
```

## Constraints

- Versions are sorted as numeric strings (e.g. "001" < "002" < "010")
- Duplicate version registration throws immediately
- Rollback requires a `down()` function - throws if missing
- State file directory is created automatically

## Integration notes

- Could replace ad-hoc migration scripts in `packages/memory/` and `packages/kernel/`
- Suitable for SQLite schema migrations or any ordered side-effect operations
- No runtime dependencies beyond Node/Bun built-ins
