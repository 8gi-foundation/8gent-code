# schema-validator - Quarantine Review

**Package:** `packages/tools/schema-validator.ts`
**Branch:** `quarantine/schema-validator`
**Status:** Quarantine - pending review before merge to main

---

## What it does

Zero-dependency JSON schema validator. Validates any JSON value against a
schema definition at runtime. No `ajv`, no `zod`, no external deps.

### Exports

| Export | Signature | Purpose |
|--------|-----------|---------|
| `validate` | `(data: unknown, schema: Schema) => ValidationResult` | Validate data against schema |
| `createSchema` | `(definition: Schema) => Schema` | Type-safe schema builder |

### Supported constraints

| Constraint | Applies to | Notes |
|------------|------------|-------|
| `type` | all | single or array of types |
| `required` | object fields | boolean on field OR array on schema |
| `pattern` | string | full regex string |
| `min` / `max` | number: value bounds; string: length bounds | |
| `minItems` / `maxItems` | array | |
| `enum` | all | deep equality via JSON.stringify |
| `properties` | object | nested field schemas |
| `items` | array | schema applied to every element |

### Supported types

`string`, `number`, `integer`, `boolean`, `object`, `array`, `null`

Note: `integer` accepts whole numbers only. `number` accepts both integers and
floats.

---

## Usage

```ts
import { validate, createSchema } from "./packages/tools/schema-validator";

const userSchema = createSchema({
  type: "object",
  required: ["id", "name"],
  properties: {
    id:    { type: "integer", min: 1 },
    name:  { type: "string", min: 1, max: 100, pattern: "^[a-zA-Z ]+" },
    email: { type: "string", pattern: "^[^@]+@[^@]+\\.[^@]+$" },
    role:  { type: "string", enum: ["admin", "user", "guest"] },
    tags:  { type: "array", items: { type: "string" }, maxItems: 10 },
    meta:  {
      type: "object",
      properties: {
        score: { type: "number", min: 0, max: 1 },
      },
    },
  },
});

const result = validate({ id: 1, name: "Eight" }, userSchema);
// { valid: true, errors: [] }

const bad = validate({ id: "not-a-number", name: "" }, userSchema);
// { valid: false, errors: [ { path: "id", message: "Expected type integer, got string" }, ... ] }
```

---

## Error format

Each error has:
- `path` - dot-notation path to the failing field (e.g. `"user.address.zip"`,
  `"items[2].name"`, or `""` for root)
- `message` - human-readable description of the constraint that failed

---

## Design decisions

- **Zero deps.** No runtime dependencies. Works in Bun, Node, Deno, browser.
- **Fail-accumulate.** All errors collected, not fail-fast. Callers get the
  full picture.
- **Type short-circuit.** If the type check fails, per-field constraint checks
  are skipped (they would be nonsensical on the wrong type).
- **integer vs number.** `integer` type requires `Number.isInteger()` to be
  true. `number` accepts both.
- **enum deep equality.** Uses `JSON.stringify` comparison, handles primitives
  and simple objects.
- **No additionalProperties enforcement.** Extra keys are silently allowed.
  Add explicit deny-list if needed.

---

## Files touched

- `packages/tools/schema-validator.ts` - implementation (new)
- `quarantine/schema-validator.md` - this file (new)

No existing files modified.

---

## Checklist before merging

- [ ] Review type handling edge cases (NaN, Infinity, -0)
- [ ] Confirm `pattern` escaping behavior is acceptable for callers
- [ ] Consider adding `additionalProperties: false` enforcement
- [ ] Wire into `packages/tools/index.ts` if needed project-wide
- [ ] Add unit tests in `packages/tools/__tests__/schema-validator.test.ts`
