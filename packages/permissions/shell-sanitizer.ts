/**
 * Shell command sanitizer shared by every run_command path:
 * - ToolExecutor.run_command (packages/eight/tools.ts)
 * - the AI SDK run_command tool (packages/ai/tools.ts)
 *
 * Blocks command substitution and command chaining, while allowing safe
 * operators like pipes and redirects. One function, so the two paths cannot
 * drift apart.
 */

import { type ShellKind, activeShellKind } from "../core/shell";

export interface ShellSanitizeResult {
	safe: boolean;
	reason?: string;
}

/** How a shell parses the line: cmd.exe, a POSIX shell (also Git Bash), or PowerShell. */
type Dialect = "cmd" | "posix" | "pwsh";

/**
 * Pick the dialect from the shell the command will really run in. With no
 * `kind`: the process's own platform follows the RESOLVED shell (Git Bash is
 * POSIX, not cmd.exe); an explicit foreign `platform` keeps its historic
 * default (win32 = cmd.exe, anything else = POSIX).
 */
function dialectFor(platform: NodeJS.Platform, kind?: ShellKind | "posix"): Dialect {
	const k = kind ?? (platform === process.platform ? activeShellKind() : platform === "win32" ? "cmd" : "posix");
	return k === "cmd" ? "cmd" : k === "powershell" ? "pwsh" : "posix";
}

type Finding = "semicolon" | "dollar-quote" | "newline" | "amp" | "pwsh-construct";

/**
 * Walk the characters outside quotes and escapes. `visit` returns a Finding to
 * stop. An unterminated quote is malformed and reported as "semicolon".
 *  - POSIX: '..' and ".." quote, backslash escapes (also inside "..").
 *  - cmd.exe: only ".." quotes, `^` escapes, a quote of any kind never hides CR/LF.
 *  - PowerShell: '..' and ".." quote, no backslash escape (backtick is refused earlier).
 */
function walk(command: string, d: Dialect, visit: (ch: string, i: number) => Finding | null): Finding | null {
	if (d === "cmd" && /[\r\n]/.test(command)) return "newline";
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (d === "posix" && ch === "\\") {
				i++;
				continue;
			}
			if (ch === '"') inDouble = false;
			continue;
		}
		if (d === "cmd" ? ch === "^" : d === "posix" && ch === "\\") {
			i++; // escaped: skip the next char, whatever it is
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "'" && d !== "cmd") {
			inSingle = true;
			continue;
		}
		const found = visit(ch, i);
		if (found) return found;
	}
	return inSingle || inDouble ? "semicolon" : null;
}

/** An unquoted CR or LF ends a command in every shell. */
function scanNewline(command: string, d: Dialect): boolean {
	return walk(command, d, (ch) => (ch === "\n" || ch === "\r" ? "newline" : null)) === "newline";
}

/**
 * Find a single `&` that separates commands, ignoring the harmless forms.
 * POSIX `&` backgrounds, cmd.exe `&` chains, PowerShell `&` calls: a second
 * command the guard never looked at. Allowed: inside quotes, escaped (POSIX
 * `\&`, cmd.exe `^&`), and the redirections `2>&1`, `>&2`, `<&0` (`&>file` on
 * POSIX). `&&` is left to the dedicated && rule. PowerShell refuses every
 * other unquoted `&`.
 */
export function hasUnquotedAmpersand(
	command: string,
	platform: NodeJS.Platform = process.platform,
	kind?: ShellKind | "posix",
): boolean {
	const d = dialectFor(platform, kind);
	return walk(command, d, (ch, i) => {
		if (ch !== "&") return null;
		const prev = command[i - 1];
		const next = command[i + 1];
		if (next === "&") return null; // `&&`: its own rule (skipping the pair is below)
		if (prev === "&") return null;
		if (prev === ">" || prev === "<") return null;
		if (d !== "cmd" && d !== "pwsh" && next === ">") return null; // &>file (bash)
		return "amp";
	}) === "amp";
}

/**
 * Find a `;` that separates commands. In POSIX and PowerShell a `;` inside
 * quotes is plain text. cmd.exe treats single quotes and `\` as plain text, so
 * there any `;` outside double quotes (and not `^`-escaped) counts.
 */
export function hasUnquotedSemicolon(
	command: string,
	platform: NodeJS.Platform = process.platform,
	kind?: ShellKind | "posix",
): boolean {
	return scanSemicolon(command, dialectFor(platform, kind)) !== null;
}

/**
 * On POSIX, bash `$'...'` and `$"..."` quote differently (`\'` is an escaped
 * quote inside `$'...'`), so this scanner cannot track them; any `$'` or `$"`
 * outside quotes is refused outright.
 */
function scanSemicolon(command: string, d: Dialect): "semicolon" | "dollar-quote" | null {
	const f = walk(command, d, (ch, i) => {
		if (d === "posix" && ch === "$" && (command[i + 1] === "'" || command[i + 1] === '"')) return "dollar-quote";
		return ch === ";" ? "semicolon" : null;
	});
	return f === "semicolon" || f === "dollar-quote" ? f : null;
}

/** PowerShell evaluates `(...)`, `@(...)`, `{...}`, `${...}`, `::` and `--%` outside quotes. */
function scanPwshConstructs(command: string): boolean {
	const hit =
		walk(command, "pwsh", (ch, i) => {
			if (ch === "(" || ch === "{") return "pwsh-construct";
			if (ch === "$" && command[i + 1] === "{") return "pwsh-construct";
			if (ch === ":" && command[i + 1] === ":") return "pwsh-construct";
			if (ch === "-" && command.startsWith("--%", i)) return "pwsh-construct";
			return null;
		}) === "pwsh-construct";
	return hit || /(^|[\s|])(iex|invoke-expression|icm|invoke-command)(?=\s|$)/i.test(command);
}

/**
 * Validate a command before it reaches the shell.
 * Returns { safe: false, reason } for a blocked command. `kind` is the shell
 * that will parse it; omitted, it follows the resolved shell on this machine.
 */
export function sanitizeShellCommand(
	command: string,
	platform: NodeJS.Platform = process.platform,
	kind?: ShellKind | "posix",
): ShellSanitizeResult {
	const d = dialectFor(platform, kind);
	// Block command substitution: $(...) and backticks
	if (/\$\(/.test(command)) {
		return {
			safe: false,
			reason: "Command substitution $(...) is not allowed",
		};
	}
	if (/`/.test(command)) {
		return {
			safe: false,
			reason: "Command substitution via backticks is not allowed",
		};
	}

	// A CR or LF outside quotes starts a second command in every shell.
	if (scanNewline(command, d)) {
		return {
			safe: false,
			reason: "A line break starts a second command and is not allowed. Use separate run_command calls instead",
		};
	}

	// Block semicolon chaining: ; cmd. A `;` inside quotes is data, not a
	// separator (e.g. magick -annotate 'a;b'), so only an unquoted one blocks.
	const semi = scanSemicolon(command, d);
	if (semi === "dollar-quote") {
		return {
			safe: false,
			reason: "Bash $'...' and $\"...\" quoting is not allowed. Use plain quotes instead",
		};
	}
	if (semi) {
		return {
			safe: false,
			reason: "Semicolon command chaining is not allowed. Use separate run_command calls instead",
		};
	}

	// Block && and || chaining
	if (/&&/.test(command)) {
		return {
			safe: false,
			reason: "Command chaining with && is not allowed. Use separate run_command calls instead",
		};
	}
	if (/\|\|/.test(command)) {
		return {
			safe: false,
			reason: "Command chaining with || is not allowed. Use separate run_command calls instead",
		};
	}

	// Block a single & separating commands anywhere in the line (background job
	// on POSIX, chaining on cmd.exe, call operator in PowerShell).
	if (hasUnquotedAmpersand(command, platform, kind)) {
		return {
			safe: false,
			reason:
				"Command chaining or background execution with & is not allowed. Use separate run_command calls instead",
		};
	}

	// PowerShell runs code inside (...), @(...), {...}, ${...} and Invoke-Expression.
	if (d === "pwsh" && scanPwshConstructs(command)) {
		return {
			safe: false,
			reason:
				"PowerShell sub-expressions ( ), { }, ${ }, ::, --% and Invoke-Expression are not allowed. Use separate powershell calls with plain arguments",
		};
	}

	return { safe: true };
}
