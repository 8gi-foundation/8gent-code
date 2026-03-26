# bulk-insert

Batch rows into chunked bulk INSERT statements.

## Requirements
- chunk(rows, size) splits rows into groups
- toInsertSQL(table, rows) generates parameterized SQL
- toValues(rows, columns) returns values array for driver
- Handles null/undefined as NULL
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/bulk-insert.ts`
