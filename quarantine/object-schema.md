# quarantine: object-schema

**Status:** Quarantined - awaiting integration review
**Package:** `packages/tools/object-schema.ts`
**Added:** 2026-03-25

## What it does

Infers and validates object shapes for runtime safety and API evolution tracking.

## Exports

| Function | Signature | Purpose |
|----------|-----------|---------|
| `inferSchema` | `(obj) => ObjectSchema` | Infers a schema from a plain object |
| `validateShape` | `(obj, schema) => boolean` | Validates obj fully conforms to schema |
| `hasShape` | `(obj, shape) => boolean` | Checks obj contains at least the fields in shape |
| `diffShapes` | `(schemaA, schemaB) => ShapeDiff` | Returns added/removed/changed keys between two schemas |

## Types

- `SchemaType` - union of primitive type strings
- `FieldSchema` - describes a single field (type, nullable, optional, nested properties)
- `ObjectSchema` - `Record<string, FieldSchema>`
- `ShapeDiff` - `{ added, removed, changed }`

## Usage

```ts
import { inferSchema, validateShape, hasShape, diffShapes } from "./packages/tools/object-schema";

const obj = { id: 1, name: "Eight", active: true };
const schema = inferSchema(obj);
// { id: { type: "number" }, name: { type: "string" }, active: { type: "boolean" } }

validateShape(obj, schema); // true
hasShape(obj, { id: { type: "number" } }); // true

const schemaV2 = { ...schema, createdAt: { type: "string" } };
diffShapes(schema, schemaV2);
// { added: ["createdAt"], removed: [], changed: {} }
```

## Integration notes

- `validateShape` recurses into nested objects when `type === "object"` and `properties` is set
- `hasShape` is intentionally permissive - extra keys on the object are ignored
- `diffShapes` is shallow - does not recurse into nested property changes
- No runtime dependencies - pure TypeScript

## Potential consumers

- `packages/eight/agent.ts` - validate tool call response shapes
- `packages/memory/store.ts` - validate memory record shapes before insert
- `packages/validation/` - supplement checkpoint verify with schema checks
- API evolution tracking in the kernel fine-tuning pipeline
