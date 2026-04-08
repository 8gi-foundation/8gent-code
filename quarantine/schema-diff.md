# schema-diff

## Tool Name
`schema-diff`

## Description
Compares two object schemas and reports structural differences. Detects added, removed, and changed fields; type changes (e.g., `string` to `number`); optional-to-required promotions; and generates human-readable migration hints classified as `BREAKING` or `Non-breaking`.

Supports nested objects and typed arrays. Zero external dependencies.

## Status
`quarantine`

## API
```ts
import { diffSchema } from "./packages/tools/schema-diff";

const result = diffSchema(beforeSchema, afterSchema);
// result.added       - fields added in after
// result.removed     - fields removed in after
// result.changed     - type/required changes
// result.identical   - true if no differences
// result.migrationHints - ordered list: breaking first, then non-breaking
```

## Integration Path
1. Import `diffSchema` in `packages/eight/tools.ts` and register as a tool callable by the agent.
2. Expose via CLI: `8gent schema-diff <before.json> <after.json>` for API evolution checks.
3. Wire into the validation pipeline (`packages/validation/`) to catch breaking schema changes in CI before they reach production.
4. Optional: use with `packages/memory/` schema migrations to auto-detect when stored record shapes have diverged from current types.
