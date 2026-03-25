# JSON Validator

Lightweight JSON schema validator with zero external dependencies.

## Status: Quarantine

Needs tests and integration review before graduating to production.

## What it does

Validates arbitrary JSON data against a schema definition. Supports:

- **Type checking** - string, number, boolean, object, array, null
- **Required fields** - ensures specified keys exist on objects
- **Enum values** - restricts values to a predefined set
- **Nested objects** - recursively validates object properties
- **Array items** - validates each element against an item schema
- **String constraints** - minLength, maxLength
- **Number constraints** - minimum, maximum

## Location

`packages/tools/json-validator.ts` (~90 lines)

## Usage

```ts
import { validate } from './packages/tools/json-validator.ts';

const schema = {
  type: 'object' as const,
  required: ['name', 'age'],
  properties: {
    name: { type: 'string' as const, minLength: 1 },
    age: { type: 'number' as const, minimum: 0 },
    role: { type: 'string' as const, enum: ['admin', 'user', 'guest'] },
    address: {
      type: 'object' as const,
      required: ['city'],
      properties: {
        city: { type: 'string' as const },
        zip: { type: 'string' as const },
      },
    },
  },
};

const result = validate({ name: 'Eight', age: 1, role: 'admin' }, schema);
// { valid: true, errors: [] }

const bad = validate({ name: '', age: -1, role: 'superadmin' }, schema);
// { valid: false, errors: [...] }
```

## Graduation criteria

- [ ] Unit tests covering all validation paths
- [ ] Integration with agent tool output validation
- [ ] Reviewed for edge cases (deeply nested, circular refs, large payloads)
