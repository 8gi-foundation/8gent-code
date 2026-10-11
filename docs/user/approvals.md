# Approvals

8gent asks before it does anything risky. How much it asks is the permission mode, and you change it at any time with **Shift+Tab**. Each tab has its own.

**Plan -> Ask -> Guarded -> Infinite -> Plan**

| Mode | Behaviour |
|---|---|
| Plan | Reads and plans. Writes, edits and any shell command that is not plainly read-only are refused |
| Ask | The default. Commands not already allowed show an approval card and wait |
| Guarded | A local checker judges each shell command. Safe ones run, risky ones show the card, blocked ones do not run |
| Infinite | Runs without asking, except the always-blocked list and pushes or uploads, which still ask. Returns to Ask after 30 minutes |

`8gent --infinite` starts every tab in Infinite.

Full detail, including child 8gents never getting more freedom than their parent: [../guides/permission-modes.md](../guides/permission-modes.md).

## The approval card

When a card appears, press a key:

| Key | Result |
|---|---|
| `y` | Approve |
| `n` | Deny |
| `e` | Edit |
| `s` | Skip |

## Allow and deny lists

`~/.8gent/permissions.json` holds `allowedPatterns` and `deniedPatterns` (glob style, such as `npm *` or `git commit *`). Safe read-only commands are allowed by default; destructive, privilege-raising and force-push commands always ask. Details: [../guides/permissions.md](../guides/permissions.md).

## Headless

With no interface attached, there is no card.

- `8gent run --yes` and `8gent chat --yes` approve ordinary commands. Catastrophic commands and the always-blocked list stay blocked.
- Without `--yes`, 8gent falls back to a prompt on stdin.

Use `--yes` only in a folder and on a machine you are happy for 8gent to change.
