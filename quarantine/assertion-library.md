# Quarantine: Assertion Library

## Status

Quarantined - not wired into test harnesses or package exports yet.

## What it does

Lightweight, zero-dependency assertion library for agent self-testing. Provides a fluent `expect()` API that any package or benchmark harness can import directly.

Supported matchers:

- **toBe** - strict equality (`===`)
- **toEqual** - deep equality (recursive object/array comparison)
- **toContain** - substring or array item membership
- **toThrow** - verify a function throws, optionally matching the error message
- **toBeType** - `typeof` check (`"string"`, `"number"`, `"boolean"`, etc.)
- **toBeNull** / **toBeUndefined** - nullish checks
- **toBeTruthy** / **toBeFalsy** - truthiness checks
- **toMatch** - regex test against a string
- **toHaveLength** - length check on strings and arrays
- **not** - negation chain (`expect(x).not.toBe(y)`)
- **use** - inline custom matcher (`expect(x).use("name", fn)`)

Throws `AssertionError` (extends `Error`) with `expected` and `actual` properties for structured error reporting.

## File

`packages/tools/assertion-library.ts` (~130 lines)

## Usage

```typescript
import { expect, AssertionError } from "./packages/tools/assertion-library.ts";

// Primitives
expect(1 + 1).toBe(2);
expect("hello world").toContain("world");
expect({ a: 1, b: 2 }).toEqual({ a: 1, b: 2 });

// Negation
expect("foo").not.toBe("bar");

// Type check
expect(42).toBeType("number");

// Throw assertion
expect(() => JSON.parse("{bad}")).toThrow();
expect(() => { throw new Error("boom") }).toThrow("boom");

// Custom matcher
expect(7).use("isOdd", (v) => (v as number) % 2 !== 0);

// Catch structured errors
try {
  expect(1).toBe(2);
} catch (e) {
  if (e instanceof AssertionError) {
    console.log(e.expected, e.actual);
  }
}
```

## Integration path

1. Wire into `benchmarks/autoresearch/harness.ts` to replace ad hoc equality checks
2. Export from `packages/tools/index.ts` once harness integration is validated
3. Use in `packages/validation/meta-eval.ts` for structured test result assertions
4. Add to the `packages/eight/tools.ts` tool registry so agents can call assertions during self-testing loops

## Before promoting

- [ ] Add test coverage via the harness itself (dogfood the library)
- [ ] Validate `toThrow` works correctly with async functions (currently sync only - needs `toThrowAsync`)
- [ ] Export from `packages/tools/index.ts`
- [ ] Wire into at least one benchmark or validation flow with a measured outcome
