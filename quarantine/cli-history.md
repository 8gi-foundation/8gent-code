# cli-history

## What it does

CLI history manager for the 8gent agent. Stores command history in `~/.8gent/history` as newline-delimited JSON. Supports search, recall by index, favorites, and auto-trim at 5000 entries.

## File

`packages/tools/cli-history.ts` (~85 lines)

## API

| Function | Description |
|----------|-------------|
| `add(command)` | Append a command to history |
| `recent(n?)` | Return last `n` entries (default 20) |
| `recall(index)` | Get entry by 1-based index from end |
| `search(query)` | Substring search (case-insensitive) |
| `toggleFavorite(command)` | Toggle favorite on matching entry |
| `favorites()` | Return all favorited entries |
| `clear()` | Wipe history |

## Storage format

One JSON object per line in `~/.8gent/history`:

```json
{"command":"bun run tui","timestamp":1711234567890,"favorite":false}
```

## Integration notes

- No external dependencies - uses Node fs/path/os only
- Auto-creates `~/.8gent/` directory if missing
- Trims to 5000 entries on `add()` when limit exceeded
- Ready to wire into TUI input handler or agent tool registry

## Status

Quarantined - needs integration tests and TUI wiring before promotion.
