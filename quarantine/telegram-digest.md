# Quarantine: Telegram Daily Digest

## What it does

Sends a morning digest to Telegram summarizing 8gent project activity from the last 24 hours.

## Data sources

- **Git log** - commit count, files changed, top contributors, recent commit messages (last 24h)
- **GitHub PRs** - open count, merged in last 24h (via `gh` CLI)
- **Benchmark report** - overall score from `benchmarks/autoresearch/autoresearch-report.json`
- **Daemon uptime** - health check against `eight-vessel.fly.dev`

## Requirements

- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `~/.claude/.env`
- `gh` CLI authenticated (for PR data)
- Network access to Telegram API and daemon endpoint

## Usage

```bash
bun run packages/proactive/telegram-digest.ts
```

Can be scheduled via cron for daily morning delivery:

```bash
# Every day at 08:00 Dublin time
0 8 * * * cd /path/to/8gent-code && bun run packages/proactive/telegram-digest.ts
```

## Exit criteria

- [ ] Sends message to Telegram with all 4 data sections
- [ ] Handles missing data gracefully (no crashes on empty git log, offline daemon, etc.)
- [ ] Works as standalone CLI script with no imports from TUI or daemon
- [ ] Token/chatId loaded from env file, not hardcoded

## Files

- `packages/proactive/telegram-digest.ts` - implementation (~150 lines)
- `quarantine/telegram-digest.md` - this spec
