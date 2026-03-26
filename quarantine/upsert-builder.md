# upsert-builder

Build INSERT ... ON CONFLICT DO UPDATE statements.

## Requirements
- upsert(table, rows, conflictColumns, updateColumns) returns {sql, params}
- Supports PostgreSQL and SQLite dialects
- Handles partial upsert (only update subset of columns)
- Validates that conflictColumns are in rows
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/upsert-builder.ts`
