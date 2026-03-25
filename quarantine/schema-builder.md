# Quarantine: schema-builder

**Status:** Quarantine - under evaluation
**Package:** `packages/tools/schema-builder.ts`
**Size:** ~145 lines

## What It Does

Fluent API for building JSON schemas programmatically. No dependencies. Pure TypeScript.

```ts
import { s } from '../packages/tools/schema-builder';

const userSchema = s.object({
  name: s.string().min(1),
  age:  s.number().min(0),
  role: s.enum(['admin', 'user']).optional(),
  tags: s.array(s.string()).optional(),
});

console.log(JSON.stringify(userSchema.toJSONSchema(), null, 2));
```

Output:
```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string", "minLength": 1 },
    "age":  { "type": "number", "minimum": 0 },
    "role": { "enum": ["admin", "user"] },
    "tags": { "type": "array", "items": { "type": "string" } }
  },
  "required": ["name", "age"]
}
```

## API Surface

| Builder | Methods |
|---------|---------|
| `s.string()` | `.min(n)` `.max(n)` `.pattern(p)` |
| `s.number()` | `.min(n)` `.max(n)` `.integer()` |
| `s.boolean()` | - |
| `s.enum([...])` | - |
| `s.array(items)` | `.minItems(n)` `.maxItems(n)` |
| `s.object(shape)` | - |

All builders share: `.optional()` `.describe(text)` `.toJSONSchema()`

## Why Quarantine

- Not yet wired into agent tool definitions or harness validation
- Evaluate whether this replaces ad-hoc schema objects in `packages/eight/tools.ts`
- Potential use: tool input schema generation, memory record validation, harness test fixtures

## Graduation Criteria

- [ ] Used in at least one real tool definition in `packages/eight/tools.ts`
- [ ] Unit test with 5+ schema shapes
- [ ] Confirmed output matches JSON Schema Draft-07
