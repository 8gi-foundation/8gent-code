# Migrations

**Status:** Quarantine - not wired into any existing code yet.

## What it does

Database/config migration system for SQLite schema changes. Reads migration files from `~/.8gent/migrations/`, tracks applied versions in a `_migrations` table, and supports up/down operations with transactional safety.

## File

`packages/tools/migrations.ts` (~120 lines)

## API

```ts
import { migrateUp, migrateDown, getPending, getApplied, status } from "@8gent/tools/migrations";
import { Database } from "bun:sqlite";

const db = new Database(".8gent/memory.db");

await migrateUp(db);                // Apply all pending migrations
await migrateDown(db, 2);           // Revert last 2 migrations
await getPending(db);               // List unapplied migrations
getApplied(db);                     // List applied migrations with timestamps
await status(db);                   // { applied: 5, pending: 1, latest: "005" }
```

## Migration file format

Files live in `~/.8gent/migrations/` and are named `{version}_{description}.sql`:

```sql
-- File: 001_add_procedures_table.sql

CREATE TABLE procedures (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  steps TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- DOWN

DROP TABLE procedures;
```

The `-- DOWN` separator splits up and down SQL. Both are run inside transactions.

## Integration points

- `packages/memory/store.ts` - could replace inline schema DDL with versioned migrations
- `packages/self-autonomy/` - evolution DB schema changes
- Any future SQLite-backed package that needs schema versioning

## To wire in

1. Import into the memory store or a CLI command
2. Create `~/.8gent/migrations/` directory
3. Move existing schema DDL into `001_initial_schema.sql`
4. Call `migrateUp(db)` at database open time
