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
 */
export function posixRulesApply(command: string, kind: ActiveShellKind): boolean {
	if (/[\r\n]/.test(command)) return false;
	if (kind === "powershell") return false;
	if (kind === "cmd" && /[\^%]/.test(command)) return false;
	return true;
}
