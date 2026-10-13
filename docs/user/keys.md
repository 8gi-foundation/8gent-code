# Keys

Type `/hotkeys` (or `/keys`) in the interface for the same list. It is printed from the one table in `apps/tui/src/lib/keybindings.ts`, and `docs.test.ts` fails if this page and that table disagree.

## Core

| Keys | Action |
|---|---|
| Enter | Send the message; while a task runs, steer it (lands after the current tool call) |
| Alt+Enter | Queue the message for after the running task |
| Ctrl+Q | Same as Alt+Enter (for Windows Terminal) |
| Esc | Stop the running task (queued text returns to the input), or close the open view |
| Tab | Accept the grey suggestion |
| Up / Down | Previous / next message you sent |
| Shift+Tab | Permission mode: Plan, Ask, Guarded, Infinite |
| Ctrl+L | Model picker |
| Alt+M | Next model in the scoped list (/scoped-models) |
| Ctrl+Z | Cycle the thinking level (/thinking) |
| /provider | Provider picker |
| Ctrl+P | Command palette |
| Ctrl+C | Save the session and quit |

## Prompt

| Keys | Action |
|---|---|
| @ | Pick a project file; Tab inserts its path |
| !cmd | Run a shell command; output goes with your next message |
| !!cmd | Run a shell command; output stays here |

## Tabs

| Keys | Action |
|---|---|
| Ctrl+T | New chat tab |
| Ctrl+W | Close the current tab |
| Ctrl+1-9 | Switch to tab by number |

## Views

| Keys | Action |
|---|---|
| Ctrl+X | Open or close the PLAN column |
| Ctrl+F | Live view of the session in 8gent Browser |
| Ctrl+Y | Cycle the work mode |
| Ctrl+G | Send the running task to the background |
| Ctrl+V | Show or hide the model's thinking |

## Extras

| Keys | Action |
|---|---|
| Ctrl+R | Start or stop voice input |
| Ctrl+D | Hand the keyboard to the DJ deck (with a track loaded) |
| Ctrl+A | Animations on or off |
| Ctrl+S | Sound on or off |

`@` and a leading `!` or `!!` are described in [Daily use](use.md).

## Windows Terminal

Windows Terminal handles some keys before 8gent sees them. Defaults differ between versions, so check yours in `settings.json` (open it with Ctrl+Shift+, or Settings, then Open JSON file).

| Key | What Windows Terminal does | Effect on 8gent |
|---|---|---|
| Alt+Enter | Toggles full screen | The key never reaches 8gent; use Ctrl+Q to queue a message |
| Shift+Enter | Sent as plain Enter | 8gent binds nothing to it; it sends the message like Enter |
| Ctrl+M | Sent as Enter | Use Ctrl+L for the model picker |
| Ctrl+C | Copies instead, while text is selected | With a selection, Ctrl+C does not reach 8gent; click to clear the selection, then press it again |
| Ctrl+Shift+anything | Windows Terminal's own actions: new tab, close pane, find, command palette, and more | 8gent binds no Ctrl+Shift key in the table above |

None of the keys in the tables above is taken by a default Windows Terminal action except Ctrl+C with a selection, so most people change nothing. If you do want Alt+Enter to reach 8gent, give it an `unbound` entry in the `actions` array of `settings.json`:

```json
{ "command": "unbound", "keys": "alt+enter" }
```

Save the file, then fully close and reopen Windows Terminal. Windows Terminal can also forward a key as a different sequence with a `sendInput` action, but 8gent has no binding for Shift+Enter, so there is nothing to forward it to; Alt+Enter and Ctrl+Q do the same thing.
