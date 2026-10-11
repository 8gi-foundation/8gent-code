# Sessions

Every conversation is saved under `~/.8gent/sessions`. Nothing to turn on.

## Resume

| Where | Command |
|---|---|
| Shell | `8gent --resume` resumes the last session |
| Shell | `8gent --resume=<name>` or `8gent --continue <id>` resumes one session |
| Shell | `8gent session resume <name-or-id>` |
| Shell | `8gent session list` (add `--limit=N` or `--json`) |
| Interface | `/resume` picks from the last 5 |
| Interface | `/history` browses all of them |
| Interface | `/continue` takes the most recent one |

Name a session so you can find it again: start with `8gent tui --name=<name>`, or use `/session name <name>` inside, or `/rename <new name>` for the tab.

## Branch and go back

| Command | What it does |
|---|---|
| `/fork [label]` | Copy the conversation at this message and continue in the copy |
| `/branch` | List branches; `/branch switch <id>` moves to one |
| `/rewind list` | List checkpoints |
| `/rewind [n]` | Go back to an earlier checkpoint |
| `/compact` | Summarize the conversation to free context |

## Export

```bash
8gent export --last          # or: 8gent export <session-id>
```

`/export` in the interface does the same: one self-contained HTML file.

## Tabs

Ctrl+T opens a tab, Ctrl+W closes it, Ctrl+1 to Ctrl+9 jump. Each tab has its own conversation and its own permission mode.

## Share a live session

`/sessions share` makes the session joinable. `/sessions attach <id>` joins one, `/sessions detach` leaves, `/sessions stop` ends sharing. A shared session can be joined from the 8gent Browser panel.

Coming soon: crash-safe session saves, recovery from an unreadable session file, and owner-only session files (#3527).
