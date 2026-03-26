# audit-log

Append-only audit log with timestamp and actor.

## Requirements
- AuditLog with log(action, actor, details?)
- AuditEntry: {id, timestamp, action, actor, details}
- query(filter?) returns matching entries
- toCSV(entries) exports as CSV
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/audit-log.ts`
