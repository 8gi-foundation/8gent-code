# Keys

Type `/hotkeys` (or `/keys`) in the interface for the same list. It is printed from the one table in `apps/tui/src/lib/keybindings.ts`, and `docs.test.ts` fails if this page and that table disagree.

## Core

| Keys | Action |
|---|---|
| Enter | Send the message (queued while a task runs) |
| Esc | Stop the running task, or close the open view |
| Tab | Accept the grey suggestion |
| Up / Down | Previous / next message you sent |
| Shift+Tab | Permission mode: Plan, Ask, Guarded, Infinite |
| Ctrl+L | Model picker |
| /provider | Provider picker |
| Ctrl+P | Command palette |
| Ctrl+C | Save the session and quit |

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
| Ctrl+Y | Cycle the work mode |
| Ctrl+Q | Cycle the flow mode: Act, Think, Quiet |
| Ctrl+G | Send the running task to the background |

## Extras

| Keys | Action |
|---|---|
| Ctrl+R | Start or stop voice input |
| Ctrl+D | Hand the keyboard to the DJ deck (with a track loaded) |
| Ctrl+A | Animations on or off |
| Ctrl+S | Sound on or off |

While you type, `@` lists project files and a leading `!` or `!!` runs a shell line; see [Daily use](use.md).

## Windows Terminal

Windows Terminal handles some keys before 8gent sees them. Defaults differ between versions, so check yours in `settings.json` (open it with Ctrl+Shift+, or Settings, then Open JSON file).

| Key | What Windows Terminal does | Effect on 8gent |
|---|---|---|
| Alt+Enter | Toggles full screen | 8gent binds nothing to it, so nothing is lost |
| Shift+Enter | Sent as plain Enter | 8gent binds nothing to it; it sends the message like Enter |
| Ctrl+M | Sent as Enter | Use Ctrl+L for the model picker |
| Ctrl+C | Copies instead, while text is selected | With a selection, Ctrl+C does not reach 8gent; click to clear the selection, then press it again |
| Ctrl+Shift+anything | Windows Terminal's own actions: new tab, close pane, find, command palette, and more | 8gent binds no Ctrl+Shift key in the table above |

None of the keys in the tables above is taken by a default Windows Terminal action except Ctrl+C with a selection, so most people change nothing. If you do want a key to reach a program, give it an `unbound` entry in the `actions` array of `settings.json`:

```json
{ "command": "unbound", "keys": "alt+enter" }
```

Save the file, then fully close and reopen Windows Terminal. Windows Terminal can also forward a key as a different sequence with a `sendInput` action, but 8gent has no binding for Shift+Enter or Alt+Enter, so there is nothing to forward them to.
