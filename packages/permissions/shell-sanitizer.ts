/**
 * Shell command sanitizer shared by every run_command path:
 * - ToolExecutor.run_command (packages/eight/tools.ts)
 * - the AI SDK run_command tool (packages/ai/tools.ts)
 *
 * Blocks command substitution and command chaining, while allowing safe
 * operators like pipes and redirects. One function, so the two paths cannot
 * drift apart.
 *
 * Quoted text is data (#3879), so a string passed to `bash -c`, `sh -c` or
 * `eval` in quotes now passes this check even when it holds `;` or `&&`. This
 * layer does not read inside those strings; System One (packages/decide
 * rules) does recurse into `bash -c`, `sh -c` and `eval`, and carries that
 * check.
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

const NEWLINE_REASON =
	"A new line outside quotes starts another command. Use separate run_command calls, or put the steps in a script file and run it with bash <file>";

const HEREDOC_REASON =
	"A heredoc needs its closing line after the body, so it cannot be checked. Put the text in a file instead";

interface QuoteScan {
	balanced: boolean;
	/** The command with quoted content removed (the quote marks stay). */
	outside: string;
	/** Content of each double-quoted span: bash still expands `$(` and backticks there. */
	doubled: string[];
	/** An unquoted `$'...'` span held a backslash: its end cannot be read reliably, so the command is refused. */
	ansiEscape: boolean;
	/** An unquoted `$'` or `$"` opened a quote span (bash quotes these differently; refused after the chaining checks). */
	dollarQuote: boolean;
	/** An unquoted newline or carriage return, outside the quotes: a second command on the next line. */
	lineBreak: boolean;
	/** A heredoc marker found outside quotes and outside a comment; the scan stopped at the end of its line. */
	heredoc?: { word: string; dash: boolean };
	/** Index just past the scanned head (the newline that ends a heredoc line, else the command length). */
	headEnd: number;
}

/**
 * POSIX quote scan (#3879). `;`, `&&`, `||` inside quotes are data, and `$(`
 * or a backtick inside SINGLE quotes is data; inside double quotes bash still
 * expands them, so the caller keeps refusing those. A backslash only escapes a
 * quote mark, `;` (#3932) or another backslash here, so `\;` and `\$(` stay refused as before.
 * An unquoted `$'...'` (ANSI-C) span with a backslash in it is refused: bash
 * ends it differently from a plain quote, and a wrong guess hides a command.
 * `#` at the start of a word, outside quotes, is a comment to the end of the
 * line and is not scanned (a quote inside a comment opens nothing). An
 * unquoted newline or carriage return is reported in `lineBreak` (a second
 * command). An unterminated quote makes `balanced` false.
 */
function scanQuotes(command: string): QuoteScan {
	let outside = "";
	const doubled: string[] = [];
	let mode: "none" | "single" | "ansi" | "double" = "none";
	let dq = "";
	let ansiEscape = false;
	let lineBreak = false;
	let dollarQuote = false;
	let escapedDollarAt = -1;
	/** Index of the character an unquoted backslash just escaped; a `#` after it is not a comment. */
	let escapedAt = -1;
	let heredoc: { word: string; dash: boolean } | undefined;
	let headEnd = command.length;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (mode === "single") {
			if (ch === "'") {
				mode = "none";
				outside += ch;
			}
			continue;
		}
		if (mode === "ansi") {
			if (ch === "\\") {
				ansiEscape = true;
				i++;
			} else if (ch === "'") {
				mode = "none";
				outside += ch;
			}
			continue;
		}
		if (mode === "double") {
			if (ch === "\\" && (command[i + 1] === '"' || command[i + 1] === "\\")) {
				i++;
				continue;
			}
			if (ch === '"') {
				doubled.push(dq);
				dq = "";
				mode = "none";
				outside += ch;
				continue;
			}
			dq += ch;
			continue;
		}
		// Unquoted, a backslash always takes the next character (bash); a `#` after it is no comment.
		if (ch === "\\") escapedAt = i + 1;
		if (ch === "\\" && (command[i + 1] === '"' || command[i + 1] === "'" || command[i + 1] === "\\" || command[i + 1] === ";")) {
			i++;
			continue;
		}
		if (ch === "<" && !heredoc && command[i + 1] === "<" && command[i - 1] !== "<" && command[i + 2] !== "<") {
			const m = /^<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/.exec(command.slice(i));
			if (m) heredoc = { word: m[3], dash: m[1] === "-" };
		}
		if (ch === "\n" && heredoc) {
			headEnd = i;
			break;
		}
		if (ch === "\n" || ch === "\r") {
			lineBreak = true;
			outside += ch;
			continue;
		}
		if (ch === "#" && (i === 0 || (escapedAt !== i - 1 && /[\s;|&(]/.test(command[i - 1])))) {
			while (i + 1 < command.length && command[i + 1] !== "\n" && command[i + 1] !== "\r") i++;
			continue;
		}
		if (ch === "\\" && command[i + 1] === "$") escapedDollarAt = i + 1;
		if ((ch === "'" || ch === '"') && command[i - 1] === "$" && escapedDollarAt !== i - 1) dollarQuote = true;
		if (ch === "'") {
			mode = command[i - 1] === "$" && command[i - 2] !== "$" && command[i - 2] !== "\\" ? "ansi" : "single";
			outside += ch;
			continue;
		}
		if (ch === '"') {
			mode = "double";
			outside += ch;
			continue;
		}
		outside += ch;
	}
	return { balanced: mode === "none", outside, doubled, ansiEscape, dollarQuote, lineBreak, heredoc, headEnd };
}

/**
 * Validate a command before it reaches the shell.
 * Returns { safe: false, reason } for a blocked command.
 */
export function sanitizeShellCommand(
	command: string,
	platform: NodeJS.Platform = process.platform,
): ShellSanitizeResult {
	// POSIX: text inside quotes is data (#3879). Windows keeps the strict whole-line rules.
	let text = command;
	let dollarQuote = false;
	if (platform !== "win32") {
		const scan = scanQuotes(command);
		if (!scan.balanced) {
			return {
				safe: false,
				reason:
					"Unbalanced quotes in the command, so it cannot be checked. Close the quote or escape the apostrophe, or put the text in a file",
			};
		}
		if (scan.ansiEscape) {
			return {
				safe: false,
				reason: "A $'...' string with a backslash cannot be checked. Use plain quotes, or put the text in a file",
			};
		}
		if (scan.lineBreak) {
			return { safe: false, reason: NEWLINE_REASON };
		}
		// Bash still expands these inside double quotes.
		if (scan.doubled.some((d) => /\$\(/.test(d))) {
			return { safe: false, reason: "Command substitution $(...) is not allowed" };
		}
		if (scan.doubled.some((d) => d.includes("`"))) {
			return { safe: false, reason: "Command substitution via backticks is not allowed" };
		}
		let body = "";
		if (scan.heredoc) {
			// The marker is real (outside quotes and comments). Its body must end with its own
			// terminator line, and nothing may follow that line: that would be another command.
			const lines = command.slice(scan.headEnd + 1).split("\n");
			const word = scan.heredoc.word;
			const end = scan.headEnd >= command.length ? -1 : lines.findIndex((l) => (scan.heredoc?.dash ? l.replace(/^\t+/, "") : l) === word);
			if (end < 0) return { safe: false, reason: HEREDOC_REASON };
			if (lines.slice(end + 1).join("\n").trim() !== "") return { safe: false, reason: NEWLINE_REASON };
			body = `\n${lines.slice(0, end + 1).join("\n")}`;
		}
		dollarQuote = scan.dollarQuote;
		text = scan.outside + body;
	}

	// Block command substitution: $(...) and backticks
	if (/\$\(/.test(text)) {
		return {
			safe: false,
			reason: "Command substitution $(...) is not allowed",
		};
	}
	if (/`/.test(text)) {
		return {
			safe: false,
			reason: "Command substitution via backticks is not allowed",
		};
	}

	// Block semicolon chaining: ; cmd. On POSIX `text` has quoted content removed (#3879,
	// #3932), so only an unquoted `;` blocks. On win32 the whole line is checked.
	if (/;/.test(text)) {
		return {
			safe: false,
			reason: "Semicolon command chaining is not allowed. Use separate run_command calls instead",
		};
	}

	// Bash $'...' and $"..." quote differently from plain quotes (#3932, 8SO). A plain $'...'
	// span without a backslash is read as a span by the scan above, but main refuses any
	// unquoted $' or $" outright, so keep that.
	if (dollarQuote) {
		return {
			safe: false,
			reason: "Bash $'...' and $\"...\" quoting is not allowed. Use plain quotes instead",
		};
	}

	// Block && and || chaining
	if (/&&/.test(text)) {
		return {
			safe: false,
			reason: "Command chaining with && is not allowed. Use separate run_command calls instead",
		};
	}
	if (/\|\|/.test(text)) {
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
