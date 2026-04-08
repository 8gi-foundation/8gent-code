# Quarantine: config-loader

**File:** `packages/tools/config-loader.ts`
**Status:** Quarantine - functional, needs integration review before wiring

---

## What it does

Loads configuration from up to four sources and deep-merges them in precedence order:

```
CLI args  >  env vars  >  config file  >  defaults
```

Supports nested keys via dot notation (e.g. `server.port`).

---

## API

### `loadConfig(options?): ConfigMap`

One-shot function. Returns a plain object.

```ts
import { loadConfig } from "@8gent/tools/config-loader";

const config = loadConfig({
  defaults: { server: { port: 3000 }, debug: false },
  filePath: ".8gent/config.json",
  envPrefix: "EIGHT_",
  cliArgs: process.argv.slice(2),
});

console.log(config.server.port); // 3000, unless overridden
```

### `ConfigLoader` class

Stateful wrapper with typed `get()`.

```ts
import { ConfigLoader } from "@8gent/tools/config-loader";

const cfg = new ConfigLoader({
  defaults: { log: { level: "info" } },
  envPrefix: "EIGHT_",
});

cfg.get<string>("log.level");   // "info" (or env override)
cfg.get<number>("server.port", 8080);  // fallback if not set
cfg.all();   // full merged map
cfg.reload({ filePath: "new-config.json" });
```

---

## File format support

| Extension | Support |
|-----------|---------|
| `.json` | Full (via `JSON.parse`) |
| `.yaml` / `.yml` | Flat key:value only (no js-yaml dependency) |

---

## Env var mapping

Prefix is stripped and `_` becomes `.`:

```
EIGHT_SERVER_PORT=9000  ->  server.port = 9000
EIGHT_DEBUG=true        ->  debug = true
```

---

## CLI arg mapping

```bash
--server.port 9000       # server.port = 9000
--server.port=9000       # same
--debug                  # debug = true (boolean flag)
```

---

## Coercion rules

| Raw string | Coerced to |
|------------|------------|
| `"true"` | `true` |
| `"false"` | `false` |
| `"null"` | `null` |
| numeric string | `number` |
| anything else | `string` |

---

## Graduation criteria

Before removing from quarantine and wiring into the main agent config path:

- [ ] Unit tests covering each precedence layer
- [ ] YAML multi-level nesting (requires js-yaml or custom parser upgrade)
- [ ] Schema validation integration with `config-validator.ts`
- [ ] Decision: replace or complement existing `.8gent/config.json` manual reads
