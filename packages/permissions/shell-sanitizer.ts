/**
 * Shell command sanitizer shared by every run_command path:
 * - ToolExecutor.run_command (packages/eight/tools.ts)
 * - the AI SDK run_command tool (packages/ai/tools.ts)
 *
 * Blocks command substitution and command chaining, while allowing safe
 * operators like pipes and redirects. One function, so the two paths cannot
 * drift apart.
 */

export interface ShellSanitizeResult {
	safe: boolean;
	reason?: string;
}

/**
 * Find a single `&` that separates commands, ignoring the harmless forms.
 *
 * POSIX (bash/sh): `&` ends a command and backgrounds it, so `a & b` runs both.
 * Windows (cmd.exe, which spawnShell uses there): `&` chains commands outright.
 * Either way it is a second command the guard never looked at.
 *
 * Allowed, because they are not command separators:
 * - inside quotes: POSIX single or double quotes; cmd.exe double quotes only
 *   (cmd.exe does not treat single quotes as quoting)
 * - escaped: POSIX `\&`; cmd.exe `^&` (cmd.exe does not treat `\` as an escape)
 * - redirections: `2>&1`, `>&2`, `<&0` on both; `&>file` / `&>>file` on POSIX
 *
 * `&&` is left to the dedicated && rule. Returns true when a separator is found.
 */
export function hasUnquotedAmpersand(
	command: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	const win = platform === "win32";
	let inSingle = false;
	let inDouble = false;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];

		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (!win && ch === "\\") {
				i++; // POSIX: backslash escapes the next char inside double quotes
				continue;
			}
			if (ch === '"') inDouble = false;
			continue;
		}

		if (win ? ch === "^" : ch === "\\") {
			i++; // escaped: skip the next char, whatever it is
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "'" && !win) {
			inSingle = true;
			continue;
		}
		if (ch !== "&") continue;

		const prev = command[i - 1];
		const next = command[i + 1];
		if (next === "&") {
			i++; // `&&`: handled by its own rule
			continue;
		}
		if (prev === ">" || prev === "<") continue; // 2>&1, >&2, <&0
		if (!win && next === ">") continue; // &>file, &>>file (bash)
		return true;
	}
	return false;
}

/**
 * Validate a command before it reaches the shell.
 * Returns { safe: false, reason } for a blocked command.
 */
export function sanitizeShellCommand(
	command: string,
	platform: NodeJS.Platform = process.platform,
): ShellSanitizeResult {
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

	// Block semicolon chaining: ; cmd
	if (/;/.test(command)) {
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
	// on POSIX, chaining on cmd.exe), including a trailing background `&`.
	if (hasUnquotedAmpersand(command, platform)) {
		return {
			safe: false,
			reason:
				"Command chaining or background execution with & is not allowed. Use separate run_command calls instead",
		};
	}

	return { safe: true };
}
