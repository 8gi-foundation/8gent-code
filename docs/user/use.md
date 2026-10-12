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
| `/help` | List the core commands; `/help all` lists every command |
| `/hotkeys` | List every keyboard shortcut |
| `/copy` | Copy the last answer to the clipboard |
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

Typing `/` alone shows only the core commands. Every other command still runs when you type its name, and shows up as soon as you type its first letters. Every key is listed in [Keys](keys.md), or type `/hotkeys`.

## Files and shell lines

**`@` file mention.** Type `@` and part of a file name. The project's files that match are listed, best match first (tracked and untracked files, not ignored ones; outside a git repository it walks the folder instead). Up and Down pick one, Tab puts `@path/to/file` into your message. A line that starts with `!` is a shell line, so `@` there is left to the shell.

**`!command`.** Runs the command in your project folder, shows the output in the chat, and sends that output to the model with your next message.

**`!!command`.** Runs the command and shows the output, but does not send it.

```text
!git status
!!ls src
```

You typed the command, so it runs like a line in your own terminal, with no approval card. Plan mode runs nothing, shell lines included. A command stops after 120 seconds, or when you press Esc. Output is cleaned of terminal control bytes and known secrets are hidden. Output from commands that read credential files or 8gent's own settings, audit files or session records is shown to you but never sent to the model. Shell lines are not saved into the session.

**`/copy`.** Puts the last answer on your clipboard. It works over SSH and in Windows Terminal, iTerm2, kitty and WezTerm, and inside tmux or screen. If your terminal ignores the clipboard sequence, select the text instead.

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
