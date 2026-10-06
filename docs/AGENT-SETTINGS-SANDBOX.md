# Agent shells cannot write ~/.8gent/settings.json (Refs #3602, #3595)

`wrapShellCommand` (packages/permissions/seatbelt.ts) runs an agent's `run_command` under a macOS Seatbelt profile that denies writes to `~/.8gent/settings.json` and unlink of `~/.8gent`, whatever the path is spelled. `touchesProtectedAgentFile` is a name-based refusal in front of it (a backstop, not a parser).

Applied to: the ToolExecutor and native `ai/tools.ts` `run_command` spawns only.

Not applied, and nothing says so yet: not macOS; `EIGHT_SEATBELT=0`; a host that already sandboxes the process (sandbox-exec cannot nest). Then the name-based refusal and System One are all that stand.

## Open items (Karen, 8SO)

- Wrap `term_spawn` / `term_send` and the background task tool (packages/tools/background.ts) through one wrapped spawn helper, and add `touchesProtectedAgentFile` there.
- Live cases for hard links and `mv` onto the file.
- Log or surface when Seatbelt is not applied.
- `/bin/sh` vs `sh` in the wrapper.
- Live tests (`bun test packages/permissions/protected-files.test.ts`) skip inside the agent sandbox; a person must run them in a normal terminal before merge.
