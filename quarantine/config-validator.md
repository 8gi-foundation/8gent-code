# Quarantine: Config Validator

**Package:** `packages/validation/config-validator.ts`
**Status:** Quarantined - not wired into index.ts exports
**Created:** 2026-03-25

## What it does

Validates `.8gent/config.json` and produces a health report covering:

1. **Schema validation** - required fields, known sections, value constraints
2. **Ollama connectivity** - checks if local model server is reachable (skipped when preferLocal is false)
3. **Daemon port availability** - verifies the configured port is not already in use
4. **Training proxy config** - validates proxy URL, base model, and config file path (only when enabled)

## Usage

```bash
# Run directly
bun run packages/validation/config-validator.ts

# From code
import { validateConfig, formatReport } from "./packages/validation/config-validator";
const report = await validateConfig("/path/to/project");
console.log(formatReport(report));
```

## Exit codes

- `0` - healthy or degraded (warnings only)
- `1` - unhealthy (one or more failures)

## Promotion criteria

- [ ] Tested against 3+ real config files (valid, partial, broken)
- [ ] Integrated into TUI onboarding flow
- [ ] Wired into `packages/validation/index.ts` exports
- [ ] Used by daemon startup preflight check
