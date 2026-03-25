# Quarantine: Notification Preferences

## Problem

No way for users to control which events produce notifications, when they fire, or through which channel. Everything is hardcoded or absent.

## What this adds

`packages/proactive/notification-preferences.ts` (~90 lines) provides:

- **Event types** - 8 notification events (task-complete, task-failed, opportunity-found, benchmark-result, session-summary, memory-consolidation, revenue-update, pr-status)
- **Channel routing** - per-event choice of `desktop`, `telegram`, or `none`
- **Quiet hours** - time window that suppresses non-critical notifications (overnight ranges supported)
- **Critical overrides** - specific events bypass quiet hours (default: task-failed)
- **Merge helper** - partial user config merged onto sensible defaults

## API

```ts
import {
  resolveChannel,
  shouldNotify,
  mergePreferences,
  listEvents,
  DEFAULT_PREFERENCES,
} from "./notification-preferences.ts";

// Which channel for this event right now?
resolveChannel("task-complete", prefs); // "desktop" | "telegram" | "none"

// Should we fire at all?
shouldNotify("session-summary", prefs); // boolean

// User overrides partial config
const prefs = mergePreferences({
  quietHours: { enabled: true, start: "23:00", end: "07:00" },
  channels: { "opportunity-found": "telegram" },
});
```

## Not doing

- Persistence (no DB/file writes - consumer wires that)
- Actual notification dispatch (desktop/telegram send logic lives elsewhere)
- UI for editing preferences (TUI concern, not this package)

## Integration path

1. Wire into `packages/proactive/index.ts` re-exports
2. Load/save via `.8gent/config.json` or memory store
3. Call `resolveChannel()` before any notification dispatch
