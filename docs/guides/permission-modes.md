# Permission modes (Shift+Tab)

How much 8gent may do before it stops and asks you. Each tab has its own mode, and you change it live with **Shift+Tab**.

## The four modes

Shift+Tab steps through them in this order, then wraps round:

**Plan -> Ask -> Guarded -> Infinite -> Plan**

| Mode | What it does | What you see |
|:-----|:-------------|:-------------|
| **Plan** | Reads and plans, changes nothing. File writes, edits, new agents, and any shell command that is not plainly read-only are refused with a reason before they run. 8gent can still read, search and propose. | `perm Plan` in the footer, in steel blue. Tab tag `· Plan` (or `P` on narrow terminals). |
| **Ask** | The default. Commands that are not already allowed show an approval card and wait for you. System One checks each shell command first: a command it blocks never reaches the card; one it allows still gets the card. | Nothing extra. Ask is the default, so the footer shows no `perm` segment. |
| **Guarded** | Safe steps run, risky ones still ask. A local checker (System One) looks at every shell command first. Commands it judges safe run without a card; commands flagged as dangerous still get the card; commands it blocks do not run. | `perm Guarded` in green. The approval card reads `ASK risky step <command>`. |
| **Infinite** | Runs everything without asking, except the always-blocked list (for example `rm -rf /`). It turns itself back to Ask after 30 minutes. | `perm Infinite` in bold orange, an `INFINITE` chip in the header, and the tab tag `∞` (or `I` on plain ASCII terminals). |

When you switch, 8gent writes one line in the chat so a screen reader hears it too, for example:

```
Permissions: Guarded: safe steps run, risky ones still ask (⇧Tab to change)
```

A short hint also shows in the footer for a few seconds.

## Turning it on or off

There is nothing to install. Permission modes are always there:

- **Shift+Tab** changes the focused tab's mode. Other tabs keep theirs.
- `8gent --infinite` starts every tab in Infinite.
- System One checks shell commands in every mode by default. With no judge model installed it checks with the safety rules and the read-only allowlist only, and says so once.
- `EIGHT_SYSTEM_ONE=1` makes it strict, as before: if its model cannot answer, the command is blocked. Guarded always works this way.
- `EIGHT_SYSTEM_ONE=0` turns System One off outside Guarded.

Guarded needs System One's local model to judge commands. If it cannot load, the command is blocked rather than run, so Guarded never becomes less safe than Ask by accident.

## Agents that start other agents

A child agent never gets more freedom than the agent that started it. It takes the stricter of its parent's mode and the one it asked for, and it stays linked: if you narrow the parent later, running children narrow too.

When that happens you see it:

- tab tag `· Plan, held`
- footer `perm Plan (held by parent)` (or `(held)` on narrow terminals)
- chat line `Held at Plan: the parent agent allows no more`

In Plan, no child agents start at all. Child agents that would run with their own permission checks switched off can only be started from Infinite.

## Other keys that changed

- Shift+Tab no longer moves to the previous tab. Use **Ctrl+1** to **Ctrl+9** to jump to a tab.
- **Ctrl+Y** still cycles the task mode (Planning, Researching, Implementing, Testing, Debugging). It is separate from permission modes.

## See also

- [permissions.md](permissions.md) - allow and deny patterns, and which commands always ask
