# Daily commands

## Command line

| Command | What it does |
|---|---|
| `8gent` | Open the chat interface |
| `8gent --resume` | Open it and resume the last session |
| `8gent --continue <id>` | Open it and resume one session by id or name |
| `8gent --fast` | Start on the fastest available model |
| `8gent run <prompt>` | One-shot run, no interface. See [Headless use](headless.md) |
| `8gent chat <message>` | Non-interactive message, pipe friendly |
| `8gent doctor` | Check Ollama, models, tools, config |
| `8gent status` | Full system status |
| `8gent review` | Review the current git diff; `8gent review --pr <number>` reviews a pull request |
| `8gent session list` | List recent sessions |
| `8gent export --last` | Export the last session as HTML |
| `8gent memory recall <query>` | Search what 8gent remembered |
| `8gent preferences get` | Show preferences |
| `8gent keys` | Edit provider keys |
| `8gent cron list` | Scheduled jobs |
| `8gent update` | Update an npm install |

Flags that work on most commands: `--model=<m>`, `--provider=<p>`, `--cwd=<dir>`, `--json`, `--yes`.

## Keys in the interface

| Key | Action |
|---|---|
| Tab | Accept the ghost suggestion |
| Shift+Tab | Permission mode: Plan, Ask, Guarded, Infinite |
| Ctrl+T / Ctrl+W | New tab / close tab |
| Ctrl+1 to Ctrl+9 | Jump to a tab |
| Ctrl+M | Model picker |
| Ctrl+Shift+M | Provider picker |
| Ctrl+L | Browse messages |
| Ctrl+X | Open or close the plan column |

## Slash commands

Type `/` in the interface. `/help` prints the live list. The ones you will use most:

| Command | What it does |
|---|---|
| `/help` | List commands (alias `/h`) |
| `/model [name]` | Pick the model (alias `/m`) |
| `/provider [name]` | Pick the provider (alias `/pr`) |
| `/status` | Session status |
| `/plan` | Current plan |
| `/clear` | Clear the screen |
| `/compact` | Summarize the conversation to free context |
| `/resume` | Pick from the last 5 sessions |
| `/history` | Browse all past sessions |
| `/continue` | Continue the most recent session |
| `/fork [label]` | Fork the conversation here |
| `/rewind [n\|list]` | Go back to an earlier checkpoint |
| `/export` | Export the session as HTML |
| `/goal <goal>` | Run a goal to completion (`/goal status`, `/goal stop`) |
| `/infinite [task]` | Autonomous until done |
| `/build <task>` | Adaptive three-model build pipeline |
| `/skills` | List loaded skills |
| `/agent [list\|spawn\|kill]` | Manage sub-8gents |
| `/term [shell]` | Open a terminal tab |
| `/settings` | Settings view |
| `/quit` | Exit |

Everything else (`/voice`, `/theme`, `/music`, `/vercel`, `/github`, `/cron`, and more) is in `/help`.
