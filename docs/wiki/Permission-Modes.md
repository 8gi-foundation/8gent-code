# Permission modes

Permission modes set how much 8gent may do before it stops and asks you. Each tab has its own mode.

The full walkthrough lives in the repo guides, so this page is a short map:

- [Permission modes guide](../guides/permission-modes.md) - what each mode shows on screen, child sessions, key changes.
- [Permissions guide](../guides/permissions.md) - allow and deny patterns, `~/.8gent/permissions.json`, `/allow`, `/deny`, commands that always ask.

## The four modes

Defined in `packages/permissions/permission-mode.ts`. They run in a strict order, least to most permissive:

| Mode | What it allows |
|:-----|:---------------|
| Plan | Read-only. Writes, edits, spawning, and shell commands that are not on the read-only allowlist are refused with a reason. 8gent can still read, search and propose. |
| Ask | The default. Shell commands the permission layer does not already allow show an approval card and wait for you. |
| Guarded | Like Ask, with System One (a local checker) in front of every shell command. A command it judges safe runs without a card, unless the permission layer flags it as dangerous. A block is final. |
| Infinite | Runs everything without a card except the always-blocked list, which never runs. Commands that must always be asked (for example pushes to the default branch) still ask. Drops back to Ask after 30 minutes. |

A child session never gets more freedom than the session that started it: it takes the stricter of its parent's mode and the one it asked for.

## Switching

- **Shift+Tab** cycles the focused tab: Plan, Ask, Guarded, Infinite, then back to Plan. Other tabs keep their mode.
- `8gent --infinite` (also `-i`) starts in Infinite. It is accepted with any command.
- `--yes` (or `-y`), `EIGHT_AUTO_APPROVE=1`, or `/auto-approve` turn on auto-approve for one run only. It is never saved to `permissions.json`.
- Ctrl+Y cycles the task mode, which is separate from permission modes.

Infinite can also be held for a whole session and remembered across runs: the terminal UI asks once and stores the answer in `~/.8gent/yolo.json`. This is read by the terminal UI only; `-p` runs and the daemon never read it. See `packages/permissions/yolo-pref.ts`.

## Unattended and headless runs

A run counts as headless when stdin is not a terminal, or `EIGHT_HEADLESS` is set (`packages/permissions/index.ts`, `isHeadless`). With nobody to ask:

- Commands on the must-ask list (such as pushes to the default branch, or network commands that send data) are denied.
- Commands the permission layer flags as dangerous (such as `rm -rf`, `sudo`, `git push --force`) are denied.
- Commands that are not flagged as dangerous are approved automatically and logged as `AUTO-APPROVED (headless)`.
- The always-blocked list is refused in every mode.

So headless is not "deny everything": ordinary commands run, risky ones are refused. If a daemon turn for the terminal UI has no way to show a card, the command is refused rather than approved. Guarded under headless also refuses what it would otherwise ask.

Related: [Configuration](Configuration) for `EIGHT_SYSTEM_ONE`, `EIGHT_HEADLESS` and the other variables.
