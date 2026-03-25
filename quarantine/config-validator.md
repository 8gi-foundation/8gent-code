# Tool: Config Validator

## Description

Validates config objects against a rule set with type checking, required field enforcement, defaults, env overrides, and helpful error messages. Supports nested dot-path fields (e.g. `"server.port"`).

## Status

**quarantine** - implemented, not yet wired into the agent tool registry or any package exports.

## Integration Path

1. Export from `packages/tools/index.ts` once reviewed.
2. Use in `packages/eight/` to validate `.8gent/config.json` on startup instead of ad hoc property checks.
3. Use in `packages/daemon/` to validate daemon launch config before binding the server.
4. Use in `packages/kernel/` to validate `config/training-proxy.yaml` fields after parsing.

## API

```ts
import { validateConfig, defineRules } from "../packages/tools/config-validator.ts";

const rules = defineRules({
  "server.port": {
    type: "number",
    required: true,
    validate: (v) => (v as number) > 0 && (v as number) < 65536 || "port must be 1-65535",
    description: "HTTP port the daemon binds to",
  },
  "model": {
    type: "string",
    required: false,
    default: "qwen2.5-coder:7b",
    env: "EIGHT_MODEL",
  },
  "debug": {
    type: "boolean",
    default: false,
    env: "EIGHT_DEBUG",
  },
});

const result = validateConfig({ "server": { "port": 3000 } }, rules);
// result.valid        → true
// result.normalized   → { server: { port: 3000 }, model: "qwen2.5-coder:7b", debug: false }
// result.warnings     → ["Field \"model\": missing, using default ...", ...]
// result.errors       → []
```

## Return Shape

```ts
interface ValidationResult {
  valid: boolean;        // false if any required field is missing or type mismatch
  errors: string[];      // blocking problems - config should be rejected
  warnings: string[];    // non-blocking notices - defaults applied, env override used
  normalized: Record<string, unknown>; // config with defaults and env overrides applied
}
```
