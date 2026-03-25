# Quarantine: Cron Manager CLI

## Status

Quarantined - not wired into main TUI or package exports.

## What it does

CLI tool that manages cron jobs on the Eight daemon via its WebSocket gateway. Supports five operations:

- **list** - display all configured cron jobs with ID, name, schedule, type, and enabled status
- **add** - create a new cron job (shell command, agent prompt, or webhook)
- **remove** - delete a job by ID
- **enable** / **disable** - toggle a job's enabled state

## File

`packages/proactive/cron-manager.ts` (~130 lines)

## Usage

```bash
# List all jobs
bun run packages/proactive/cron-manager.ts list

# Add a shell job that runs every 30 minutes
bun run packages/proactive/cron-manager.ts add "health-check" "*/30 * * * *" shell "curl -s http://localhost:8741/health"

# Add an agent prompt that runs daily at 9am
bun run packages/proactive/cron-manager.ts add "morning-brief" "0 9 * * *" agent-prompt "Summarize overnight activity"

# Remove a job
bun run packages/proactive/cron-manager.ts remove cron_abc123

# Disable/enable
bun run packages/proactive/cron-manager.ts disable cron_abc123
bun run packages/proactive/cron-manager.ts enable cron_abc123
```

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `EIGHT_DAEMON_URL` | `ws://localhost:8741` | Daemon WebSocket URL |

## Dependencies

- Daemon must be running (the CLI connects via WebSocket)
- Uses `CronJob` and `JobType` types from `packages/daemon/cron.ts`

## Before promoting

- [ ] Add integration tests with a mock WebSocket server
- [ ] Wire into the TUI as a `/cron` command
- [ ] Add to the proactive package's `index.ts` exports
- [ ] Consider adding a `cron:toggle` message type to the gateway so enable/disable is atomic (currently uses remove + re-add)
