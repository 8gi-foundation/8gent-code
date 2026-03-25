# permission-set

## Tool Name
`permission-set`

## Description
Unix-style permission bitmask operations for agent tool authorization. Defines permissions as read/write/exec bits (4/2/1), supports combining sets with OR, checking access with AND, formatting as rwx strings, and parsing from string or octal notation. Maps to the familiar rwxrwxrwx owner/group/other model.

## Status
`quarantine`

Not yet integrated into the agent runtime. Isolated for review and testing before wiring into NemoClaw policy engine or tool authorization gates.

## Integration Path
1. Import `PermissionSet` from `packages/permissions/permission-set.ts`
2. Wire into `packages/permissions/policy-engine.ts` - use `PermissionSet.fromOctal()` to parse policy rules, `allows()` to gate tool calls
3. Surface per-tool permission requirements in tool definitions (`packages/eight/tools.ts`)
4. Optionally expose in the TUI permissions view for user-facing permission display
