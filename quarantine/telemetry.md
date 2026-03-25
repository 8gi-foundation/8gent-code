# Quarantine: Telemetry

**Package:** `packages/tools/telemetry.ts`
**Status:** Quarantined - not wired into any existing code.
**Branch:** `quarantine/telemetry`

## What it does

Privacy-first anonymous usage telemetry for 8gent Code.

- **Opt-in only.** Collection is disabled by default. The user must explicitly call `setEnabled(true)`.
- **No PII.** Only anonymous stats: command names used, session duration, model preference string. No usernames, paths, IPs, or conversation content.
- **Local-first.** All data stored in SQLite at `.8gent/telemetry.db`. Nothing leaves the machine unless the user calls `export()` and manually uploads.
- **Purgeable.** `purge()` wipes everything instantly.

## API surface

| Method | Description |
|--------|-------------|
| `new TelemetryStore(dataDir, optIn?)` | Create store. `optIn` defaults to `false`. |
| `setEnabled(on)` | Toggle collection at runtime. |
| `isEnabled()` | Check current state. |
| `track(event, payload?)` | Record an event. No-op when disabled. |
| `endSession(modelPref?)` | Finalize session, record summary. |
| `export()` | Return all events as JSON string. |
| `purge()` | Delete all stored telemetry data. |
| `close()` | Close the database connection. |

## What it collects (when enabled)

- Command/event names (e.g. `command:run`, `tool:browser`)
- Session duration in milliseconds
- Model preference string (e.g. `qwen3.5`, `openrouter/free`)
- Timestamps (ISO 8601, no timezone - just UTC)

## What it never collects

- File paths, usernames, hostnames
- Conversation content or prompts
- API keys or tokens
- IP addresses or network info

## Integration path

When promoted out of quarantine:

1. Wire into `packages/eight/agent.ts` session lifecycle.
2. Add a `telemetry: { enabled: false }` key to `.8gent/config.json`.
3. Surface opt-in toggle in onboarding flow and settings.
4. Optional: add an upload endpoint for aggregated anonymous stats.

## Size

~90 lines TypeScript. Zero external dependencies beyond `bun:sqlite`.
