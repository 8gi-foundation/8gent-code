# quarantine: record-builder

**Status:** quarantine - review before wiring into agent loop

## What it does

`RecordBuilder<T>` is an immutable fluent builder for constructing typed records.
Every method returns a new builder, leaving the original unchanged. `build()` is
the terminal operation that returns the final plain object.

## API

```ts
import { builder, RecordBuilder } from "../packages/tools/record-builder.ts";

const record = builder<{ name: string; role: string; active: boolean }>({ active: true })
  .set('name', 'James')
  .setIf(isAdmin, 'role', 'admin')
  .merge({ role: 'user' })
  .build();

const slim = builder<User>(rawUser).omit('password').pick('name', 'email').build();

const payload = builder<Payload>().set('userId', id).build(['userId', 'sessionId']);
```

## Features

- Fully immutable - every method returns a new `RecordBuilder` instance
- `set(key, value)` - single key assignment
- `setIf(condition, key, value)` - conditional set (boolean or lazy `() => boolean`)
- `merge(partial)` - bulk overwrite
- `omit(...keys)` - remove keys, narrows the type
- `pick(...keys)` - retain only listed keys, narrows the type
- `transform(fn)` - bulk mutation inside the chain
- `get(key)` / `has(key)` / `size()` - inspection without building
- `build(required?)` - returns `Partial<T>`, optional required-key check
- `buildUnsafe()` - returns `T` when all fields are guaranteed present

## Constraints

- `omit` and `pick` narrow the generic type - subsequent chain uses the narrowed type
- `build()` returns `Partial<T>` - use `buildUnsafe()` only when full type is guaranteed
- No schema validation built in - pair with `zod` at the `build()` boundary

## Files

- `packages/tools/record-builder.ts` - implementation (~90 lines)

## Not doing

- No schema/validation built in - compose with external validator
- No deep merge - `merge()` is shallow, use `transform()` for nested mutations
- No serialisation helpers - plain `JSON.stringify` on the output is fine
