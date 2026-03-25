# Quarantine: Telegram Commands

## What

Structured command handler for the Telegram bridge. Five commands that return formatted Markdown text for Telegram delivery.

## Commands

| Command | Purpose |
|---------|---------|
| `/status` | System status - daemon health, Ollama, sessions, git info |
| `/prs` | List open PRs via `gh` CLI |
| `/health` | Codebase health score (type errors, uncommitted files, test count) |
| `/standup` | Daily standup - last 24h commits, stats, branch |
| `/scan [query]` | Search GitHub for bounties/opportunities via `gh search issues` |

## Integration

The handler exports `handleCommand(text)` which returns `{ text, parseMode }` or `null` if unrecognized.

To wire into `telegram-bridge.ts`, call `handleCommand()` before routing to the agent:

```ts
import { handleCommand } from "../../packages/proactive/telegram-commands";

// In handleTelegramMessage():
const cmdResult = await handleCommand(text);
if (cmdResult) {
  await tgSend(token, chatId, cmdResult.text, cmdResult.parseMode);
  return;
}
```

## Dependencies

- `child_process` (Node built-in) for git/gh CLI calls
- `fetch` (global) for daemon health and Ollama API
- `gh` CLI (optional) for /prs and /scan
- No external packages required

## Files

- `packages/proactive/telegram-commands.ts` - command handler (~150 lines)
- `quarantine/telegram-commands.md` - this spec

## Graduation criteria

- Wire into telegram-bridge.ts and test all 5 commands via Telegram
- Confirm output formatting renders correctly in Telegram Markdown
- Add timeout handling for slow commands (tsc can take 30s+)
