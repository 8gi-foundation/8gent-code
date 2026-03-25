# Tool: Value Transformer

## Description

Chainable value transformation pipeline. Wraps any value in a `Transform<T>` monad that supports `map`, `filter`, `tap`, `catch`, `default`, `validate`, `toJSON`, and `toString` chains - all fully async-capable. A top-level `transform(value)` function provides the entry point.

## Status

**quarantine** - implemented, not yet wired into the agent tool registry or any package exports.

## Integration Path

1. Export from `packages/tools/index.ts` once reviewed.
2. Use in agent tool post-processing to sanitize, validate, and normalize LLM output before it reaches callers.
3. Candidate for replacing ad hoc null-checks and type coercions scattered across `packages/eight/tools.ts`.
4. The `validate` step pairs naturally with the NemoClaw policy engine - pipe tool results through a policy-aware validator before returning them.

## API

```ts
import { transform, ValidationError } from "../packages/tools/value-transformer.ts";

// Basic chain
const result = await transform("  hello world  ")
  .map((s) => s.trim())
  .map((s) => s.toUpperCase())
  .validate((s) => s.length > 0 || "String must not be empty")
  .tap((s) => console.log("transformed:", s))
  .value();
// => "HELLO WORLD"

// filter returns undefined when predicate fails
const filtered = await transform(42)
  .filter((n) => n > 100)
  .default(0)
  .value();
// => 0

// catch recovers from errors
const safe = await transform(null as string | null)
  .validate((v) => v !== null || "Value must not be null")
  .catch(() => "fallback")
  .value();
// => "fallback"

// toJSON / toString
const json = await transform({ id: 1, name: "eight" }).toJSON().value();
// => '{"id":1,"name":"eight"}'

// ValidationError carries the offending value
try {
  await transform(-5).validate((n) => n >= 0 || "Must be non-negative").value();
} catch (e) {
  if (e instanceof ValidationError) {
    console.error(e.message, e.value); // "Must be non-negative" -5
  }
}
```
