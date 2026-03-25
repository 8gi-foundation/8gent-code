# data-validator

**Status:** Quarantine - under evaluation
**Package:** `packages/tools/data-validator.ts`

## What it does

Fluent chainable data validation. Build schemas with a `v.*` builder, call `.validate(data)`, get back `{ valid, errors }`.

## API

```ts
import { v } from "../packages/tools/data-validator";

// String
v.string().min(3).max(100).email().validate("user@example.com");
// => { valid: true, errors: [] }

// Number
v.number().min(0).max(100).integer().validate(42);
// => { valid: true, errors: [] }

// Array of strings
v.array().of(v.string()).validate(["hello", "world"]);
// => { valid: true, errors: [] }

// Object schema
v.object({ name: v.string().min(1) }).validate({ name: "Eight" });
// => { valid: true, errors: [] }
```

## Return type

```ts
{ valid: boolean; errors: string[] }
```

Errors are field-prefixed for arrays (`[0]: must be a string`) and objects (`name: must be a string`).

## Size

~130 lines. No dependencies.

## Acceptance criteria

- [ ] All four validator types work correctly in unit tests
- [ ] Chained rules accumulate errors (not short-circuit)
- [ ] Nested schemas produce prefixed error paths
- [ ] No external dependencies introduced
