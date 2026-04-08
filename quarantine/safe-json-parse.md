# safe-json-parse

## Tool Name
`safe-json-parse`

## Description
Non-throwing JSON parse utilities returning a `Result<T>` type instead of throwing on failure. Includes optional type guard validation, circular-reference-safe stringify, and a lenient parser that strips comments and trailing commas (JSONC support).

### Exported API

| Function | Signature | Purpose |
|----------|-----------|---------|
| `safeParse` | `(str: string) => Result<unknown>` | Parse JSON, never throws |
| `safeParseAs` | `<T>(str, validator: Validator<T>) => Result<T>` | Parse + type guard validation |
| `safeStringify` | `(val, indent?) => Result<string>` | Stringify with circular ref handling |
| `parseLenient` | `(str: string) => Result<unknown>` | Parse JSONC (comments + trailing commas) |

### Result Type

```ts
type Ok<T>  = { ok: true;  data: T;         error: undefined };
type Err    = { ok: false; data: undefined;  error: string };
type Result<T> = Ok<T> | Err;
```

## Status
**quarantine** - self-contained, no external deps, not yet wired into the agent tool index.

## Integration Path

1. Export from `packages/tools/index.ts` once reviewed.
2. Register in `packages/eight/tools.ts` if the agent needs JSON parsing as a named tool.
3. Use `safeParseAs` with a type guard wherever structured config or API response parsing is needed.
4. `parseLenient` is suitable for reading `.8gent/config.json` (which may be authored as JSONC by users).
