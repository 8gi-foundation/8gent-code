# Feature Flags

**Status:** Quarantine - not wired into any existing code yet.

## What it does

Simple feature flag system that reads from `~/.8gent/flags.json`. Three flag types:

- **boolean** - on/off toggle
- **percentage** - gradual rollout (deterministic per user via SHA-256 hash)
- **user-target** - enable for specific user IDs, with optional default

## File

`packages/tools/feature-flags.ts` (~90 lines)

## API

```ts
import { isEnabled, listFlags, invalidateCache } from "@8gent/tools/feature-flags";

isEnabled("new-memory-engine");              // boolean check
isEnabled("new-memory-engine", "user-123");  // percentage or user-target check
listFlags();                                 // get all definitions
invalidateCache();                           // force re-read from disk
```

## flags.json format

```json
{
  "new-memory-engine": {
    "type": "boolean",
    "enabled": true
  },
  "experimental-ui": {
    "type": "percentage",
    "percentage": 25
  },
  "beta-testers": {
    "type": "user-target",
    "enabled": ["james", "charles"],
    "default": false
  }
}
```

## Wiring plan

Once promoted from quarantine:

1. Import in agent loop to gate experimental features
2. Add CLI command (`8gent flags list`, `8gent flags set`)
3. Wire into TUI settings screen

## Constraints

- No external dependencies - uses Node crypto and fs
- File is re-read only when mtime changes (simple cache)
- No write API - flags.json is edited manually or by scripts
