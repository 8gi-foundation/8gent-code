# migration-state

Track and apply database migration state.

## Requirements
- Migration: {id, name, up: string, down: string}
- MigrationState tracks applied migration IDs
- getPending(applied[]) returns unapplied migrations in order
- markApplied(id, appliedList) returns new list
- isValid(migrations) checks for duplicate IDs

## Status

Quarantine - pending review.

## Location

`packages/tools/migration-state.ts`
