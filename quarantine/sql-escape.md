# sql-escape

Escape values for SQL string interpolation (last-resort only).

## Requirements
- escapeString(value) escapes single quotes by doubling
- escapeIdentifier(name) wraps in double-quotes and escapes
- escapeWildcard(value) escapes LIKE wildcards
- warn(msg) logs to console that parameterized queries are preferred
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/sql-escape.ts`
