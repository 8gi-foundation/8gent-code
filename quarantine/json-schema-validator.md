# json-schema-validator

## Tool Name
`json-schema-validator`

## Description
Validates JSON data against JSON Schema draft-07 subset definitions. Returns a structured result
with a `valid` boolean and an `errors` array containing path-keyed messages for every constraint violation.

Supported keywords:
- `type` (string, number, integer, boolean, object, array, null, or array of types)
- `required` (array of required property names)
- `properties` (recursive property schemas)
- `items` (schema for array elements)
- `enum` (allowed values)
- `pattern` (regex pattern for strings)
- `minimum` / `maximum` (numeric bounds)
- `minLength` / `maxLength` (string length bounds)
- `minItems` / `maxItems` (array length bounds)
- `additionalProperties` (boolean or schema)

## Status
**quarantine** - implemented and self-contained, not yet wired into the agent tool registry.

## Integration Path
1. Import `validate` from `packages/tools/json-schema-validator.ts`
2. Use in `packages/eight/tools.ts` to validate structured tool call arguments before dispatch
3. Can also be used in `packages/permissions/policy-engine.ts` for schema-gated tool permissions
4. Export from `packages/tools/index.ts` once reviewed

## Usage Example

```ts
import { validate } from "../packages/tools/json-schema-validator.ts";

const result = validate({ name: "Eight", age: 2 }, {
  type: "object",
  required: ["name", "age"],
  properties: {
    name: { type: "string", minLength: 1 },
    age:  { type: "integer", minimum: 0 }
  }
});

// result.valid === true
// result.errors === []
```
