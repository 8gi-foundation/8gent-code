# Daily use

## Command line

| Command | What it does |
|---|---|
| `8gent` | Open the chat interface |
| `8gent --resume` | Resume the last session |
| `8gent --continue <id>` | Resume one session |
| `8gent session list` | List recent sessions |
| `8gent export --last` | Export a session as HTML |
| `8gent run <prompt>` | One-shot run, see [Headless](headless.md) |
| `8gent review` | Review the current git diff |
| `8gent doctor` | Check models and tools |

## In the interface

| Command | What it does |
|---|---|
| `/help` | List commands |
| `/model [name]` | Pick the model |
| `/provider [name]` | Pick the provider |
| `/status` | Session status |
| `/plan` | Current plan |
| `/compact` | Summarize to free context |
| `/goal <goal>` | Run a goal to completion |
| `/resume` | Pick from the last 5 sessions |
| `/history` | Browse all sessions |
| `/fork [label]` | Branch the conversation |
| `/rewind [n\|list]` | Go back to a checkpoint |
| `/export` | Export as HTML |
| `/sessions share` | Make the session joinable |
| `/skills` | List skills |
| `/quit` | Exit |

| Key | Action |
|---|---|
| Ctrl+T, Ctrl+W | New tab, close tab |
| Ctrl+1 to Ctrl+9 | Jump to a tab |
| Ctrl+M | Model picker |
| Shift+Tab | Permission mode |

Sessions are saved in `~/.8gent/sessions`.

## Approvals

Shift+Tab steps through the permission modes for the tab: Plan, Ask, Guarded, Infinite.

| Mode | Behaviour |
|---|---|
| Plan | Reads and plans, changes nothing |
| Ask | Shows an approval card for commands not already allowed |
| Guarded | Safe commands run, risky ones show the card |
| Infinite | Runs without asking, apart from the always-blocked list and pushes |

On a card: `y` approve, `n` deny, `e` edit, `s` skip. Allow and deny patterns live in `~/.8gent/permissions.json`. More: [permission-modes](../guides/permission-modes.md), [permissions](../guides/permissions.md).
