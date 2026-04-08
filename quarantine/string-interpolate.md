# string-interpolate

**Status:** Quarantine - awaiting integration review

## What it does

Safe named-variable string interpolation with format pipes and configurable
missing-variable handling. Zero dependencies.

| Export | Signature |
|--------|-----------|
| `interpolate` | `(template, context, opts?) => string` |

## Placeholder syntax

```
{varPath}               plain substitution
{varPath:formatter}     with formatter
{varPath:formatter:arg} with formatter argument
```

Nested property access uses dot notation: `{user.address.city}`.

## Built-in formatters

| Formatter | Argument | Description |
|-----------|----------|-------------|
| `iso` | - | Date/timestamp to ISO 8601 string |
| `fixed` | `:N` | Number to N decimal places (default 2) |
| `upper` | - | String to UPPERCASE |
| `lower` | - | String to lowercase |
| `trim` | - | Trim leading/trailing whitespace |
| `json` | - | JSON.stringify the value |

## Missing variable handling

```ts
interface InterpolateOptions {
  missing?: "throw" | "blank" | "keep"; // Default: "throw"
}
```

| Mode | Behaviour |
|------|-----------|
| `"throw"` | Throws `RangeError` with variable path (default - fail fast) |
| `"blank"` | Replaces missing variable with empty string |
| `"keep"` | Leaves the original `{placeholder}` untouched |

## Usage

```ts
import { interpolate } from "../packages/tools/string-interpolate";

// Basic
interpolate("Hello {name}!", { name: "World" });
// -> "Hello World!"

// Nested access
interpolate("City: {user.address.city}", { user: { address: { city: "Dublin" } } });
// -> "City: Dublin"

// Date formatter
interpolate("Created: {ts:iso}", { ts: new Date("2025-01-01") });
// -> "Created: 2025-01-01T00:00:00.000Z"

// Number formatter
interpolate("Price: {amount:fixed:2}", { amount: 9.5 });
// -> "Price: 9.50"

// String formatter
interpolate("Status: {state:upper}", { state: "active" });
// -> "Status: ACTIVE"

// Missing - blank
interpolate("Hi {user}", {}, { missing: "blank" });
// -> "Hi "

// Missing - keep
interpolate("Hi {user}", {}, { missing: "keep" });
// -> "Hi {user}"
```

## File

`packages/tools/string-interpolate.ts` - 140 lines, zero dependencies.

## Integration candidates

- `packages/eight/prompts/system-prompt.ts` - system prompt variable injection
- `packages/self-autonomy/reflection.ts` - reflection template rendering
- Any agent that builds prompt strings from structured context objects
- Log/notification message templating throughout the daemon
