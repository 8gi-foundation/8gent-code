# env-interpolator

**Status:** quarantine

## Description

Interpolates `${VAR}` and `${VAR:-default}` references in config strings from environment variables. Supports nested references (resolved iteratively up to configurable depth), detects missing variables without defaults, and can operate over full config objects recursively.

## Exports

| Export | Signature | Description |
|--------|-----------|-------------|
| `interpolate` | `(template, env?, options?) => InterpolateResult` | Interpolate a single string |
| `interpolateConfig` | `(config, env?, options?) => { config, missing }` | Interpolate all string leaves in a config object |

## Features

- `${VAR}` - basic variable reference
- `${VAR:-default}` - value with fallback default
- Nested references in both values and defaults (up to `maxDepth`, default 10)
- Collects all missing variables (no silent failures)
- Strict mode: throws on missing variables
- No runtime dependencies

## Integration Path

1. Import in `packages/eight/prompts/system-prompt.ts` to interpolate user context segments from env
2. Import in any loader that reads `.8gent/config.json` to expand `${HOME}`, `${MODEL}`, etc.
3. Wire into `packages/permissions/policy-engine.ts` for YAML policy files that reference env vars

## File

`packages/tools/env-interpolator.ts` - self-contained, ~120 lines, zero deps.
