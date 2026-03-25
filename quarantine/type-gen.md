# type-gen - TypeScript Type Generator

**Status:** Quarantine
**Package:** `packages/tools/type-generator.ts`
**Size:** ~100 lines

## Problem

When working with JSON APIs, config files, or sample data, manually writing TypeScript interfaces is tedious and error-prone. A generator that infers types from a JSON sample eliminates that friction.

## What it does

- Accepts any JSON-compatible value (parsed object or raw string)
- Infers primitive types: `string`, `number`, `boolean`, `null`
- Infers arrays with homogeneous or union element types
- Recursively handles nested objects, emitting separate named interfaces
- Deduplicates interfaces with identical shapes (fingerprint-based)
- Handles unsafe property names (quoted keys)
- Marks nullable fields as optional

## API

```ts
import { generateTypes, generateTypesFromString } from './packages/tools/type-generator'

// From a parsed object
const ts = generateTypes({ name: 'Ada', age: 30, tags: ['ai'] }, 'User')
// interface User {
//   age: number;
//   name: string;
//   tags: string[];
// }

// From a raw JSON string
const ts2 = generateTypesFromString('{"id": 1, "active": true}', 'Record')
```

## Graduation criteria

- [ ] Unit tests covering primitives, arrays, nested objects, edge cases
- [ ] Integration with Eight's tool system (callable from agent loop)
- [ ] Proven useful in at least one real workflow (API response typing, config typing)

## Not doing

- Generic/template inference
- Discriminated unions
- JSON Schema output (only TypeScript interfaces)
- Enum detection from repeated string values
