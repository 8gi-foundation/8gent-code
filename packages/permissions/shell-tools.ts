/**
 * The tools that run a shell command line. One list, so a new shell tool (the
 * Windows `powershell` tool) cannot be gated as run_command in one place and
 * forgotten in another: maker-checker, architect/review modes, plan mode, the
 * /goal deny list and the breaker's refusal check all read it.
 */
export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(["run_command", "powershell"]);

export const isShellToolName = (name: string): boolean => SHELL_TOOL_NAMES.has(name);

export type ActiveShellKind = "git-bash" | "powershell" | "cmd" | "posix";

/**
 * Can the POSIX-flavoured rule engines (the read-only allowlist, the S1 rm/mv/
 * run/curl rules, the safe-prefix list) judge this command line? They split on
 * POSIX quoting. cmd.exe (`^` escapes, `%VAR%`) and PowerShell (`(...)`, `@(...)`,
 * `{...}`, `&`) parse the same text differently, and a CR or LF ends a command
 * in every shell, so for those lines the rules give no opinion and the line
 * goes to the person or the judge.
 *
 * The rules read `command.trim()`, and JavaScript's trim also strips characters
 * a POSIX shell keeps as part of a word (no-break space, BOM, ideographic space,
 * vertical tab and the rest). `rm -rf .tmp<U+00A0>` was judged as `.tmp` and
 * deleted `.tmp<U+00A0>`, a folder the session never made (8SO on #4185). A line
 * that trim would shorten by anything other than spaces and tabs gets no opinion.
 */
export function posixRulesApply(command: string, kind: ActiveShellKind): boolean {
	if (/[\r\n]/.test(command)) return false;
	if (command.trim() !== command.replace(/^[ \t]+|[ \t]+$/g, "")) return false;
	if (kind === "powershell") return false;
	if (kind === "cmd" && /[\^%]/.test(command)) return false;
	return true;
}
