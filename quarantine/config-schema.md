# Quarantine: Config Schema

## Status

Quarantined - not wired into agent configuration loading or package exports yet.

## What it does

Typed configuration schema with defaults, validation, type coercion, and environment variable mapping. Any package or agent can define a schema once and get a fully validated, typed config object from any source (plain object, env vars, or both combined).

Supported field types:

- **string** - string value, coerced via `String()`
- **number** - numeric value, coerced via `Number()`
- **boolean** - boolean, accepts `true/false`, `1/0`, `yes/no` string forms
- **string[]** - string array, accepts arrays or comma-separated strings from env

Key features:

- **env var mapping** - each field can declare an `env` key; env vars override source object values
- **defaults** - fields with no value fall back to the declared default
- **required** - missing required fields are collected into the errors array
- **custom validators** - per-field `validate(value)` function returning an error string or null
- **type coercion** - values from env are always strings; coercion handles the conversion
- **non-throwing** - returns `{ config, errors, valid }` so callers decide how to handle failures

## File

`packages/tools/config-schema.ts` (~130 lines)

## Usage

```typescript
import { defineConfig, parseConfig, parseConfigFromEnv } from "./packages/tools/config-schema.ts";

const AgentConfig = defineConfig({
  model: {
    type: "string",
    default: "qwen2.5-coder:7b",
    env: "EIGHT_MODEL",
    description: "LLM model identifier",
  },
  maxTokens: {
    type: "number",
    default: 4096,
    env: "EIGHT_MAX_TOKENS",
    validate: (v) => (v > 0 ? null : "must be positive"),
  },
  debug: {
    type: "boolean",
    default: false,
    env: "EIGHT_DEBUG",
  },
  allowedTools: {
    type: "string[]",
    default: ["bash", "read", "write"],
    env: "EIGHT_ALLOWED_TOOLS",
  },
});

// Parse from a plain object (e.g. .8gent/config.json)
const { config, errors, valid } = parseConfig(AgentConfig, {
  model: "ollama/qwen2.5-coder",
  maxTokens: 8192,
});

if (!valid) {
  console.error("Config errors:", errors);
  process.exit(1);
}

// Parse from env vars only
const { config: envConfig } = parseConfigFromEnv(AgentConfig);
```

## Integration path

1. Wire into `packages/eight/agent.ts` to replace ad hoc `process.env` reads
2. Use in `packages/daemon/` for vessel daemon startup configuration
3. Export from `packages/tools/index.ts` once used in at least one real config load path
4. Wire into `packages/kernel/` training proxy config loading (currently YAML-only)

## Before promoting

- [ ] Add test coverage via `benchmarks/autoresearch/harness.ts`
- [ ] Validate env var override precedence with a real agent config
- [ ] Export from `packages/tools/index.ts`
- [ ] Replace at least one `process.env.FOO ?? "default"` pattern in the codebase with a schema-defined field
