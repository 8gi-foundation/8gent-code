# feature-flag-manager

## Tool Name
`FeatureFlags` (packages/tools/feature-flag-manager.ts)

## Description
Manages feature flags with percentage-based rollout, user targeting, and runtime overrides. Enables gradual feature deployment by bucketing users deterministically per flag, supporting allowlists/blocklists for pinned targeting, and emergency kill switches via runtime overrides.

## Status
**quarantine** - self-contained, not yet wired into the agent or TUI.

## Integration Path
1. Import into `packages/eight/tools.ts` as a registered agent tool.
2. Expose `isEnabled(flag, userId)` in the system prompt context so Eight can gate behaviours per user per session.
3. Optionally surface a `/flags` command in the TUI to list and toggle flags interactively.
4. Load flag definitions from `.8gent/flags.json` at startup via `FeatureFlags.loadJSON()`.

## API Summary

```ts
const flags = new FeatureFlags({ flags: [...] });

flags.isEnabled("new-memory-ui", userId);    // true/false
flags.override("new-memory-ui", "force-on"); // emergency override
flags.override("new-memory-ui", null);        // clear override
flags.list();                                 // all registered flags
```

## Example Config (`.8gent/flags.json`)

```json
{
  "flags": [
    {
      "name": "new-memory-ui",
      "description": "Redesigned memory panel in TUI",
      "enabled": false,
      "rollout": 10,
      "allowlist": ["user-james"]
    }
  ]
}
```
