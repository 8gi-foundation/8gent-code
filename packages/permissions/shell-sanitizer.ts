/**
 * Shell command sanitizer shared by every run_command path:
 * - ToolExecutor.run_command (packages/eight/tools.ts)
 * - the AI SDK run_command tool (packages/ai/tools.ts)
 *
 * Blocks command substitution, process substitution and command chaining,
 * while allowing safe operators like pipes and redirects. One function, so the
 * two paths cannot drift apart.
 *
 * Quoted text is data (#3879), so a string passed to `bash -c`, `sh -c` or
 * `eval` in quotes now passes this check even when it holds `;` or `&&`. This
 * layer does not read inside those strings; System One (packages/decide
 * rules) does recurse into `bash -c`, `sh -c` and `eval`, and carries that
 * check.
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
	const k =
		kind ??
		(platform === process.platform ? activeShellKind() : platform === "win32" ? "cmd" : "posix");
	return k === "cmd" ? "cmd" : k === "powershell" ? "pwsh" : "posix";
}

type Finding = "semicolon" | "dollar-quote" | "newline" | "amp" | "pwsh-construct";

/**
 * Process substitution `<(cmd)` / `>(cmd)` runs cmd exactly as `$(cmd)` does, with the
 * output on a pipe path instead of inline, so it is judged wherever `$(` is judged.
 */
const PROCESS_SUBSTITUTION = /[<>]\(/;
const PROCESS_SUBSTITUTION_REASON = "Process substitution <(...) and >(...) is not allowed";

/**
 * Walk the characters outside quotes and escapes. `visit` returns a Finding to
 * stop. An unterminated quote is malformed and reported as "semicolon".
 *  - POSIX: '..' and ".." quote, backslash escapes (also inside "..").
 *  - cmd.exe: only ".." quotes, `^` escapes, a quote of any kind never hides CR/LF.
 *  - PowerShell: '..' and ".." quote, no backslash escape (backtick is refused earlier).
 */
function walk(
	command: string,
	d: Dialect,
	visit: (ch: string, i: number) => Finding | null,
): Finding | null {
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
	return (
		walk(command, d, (ch, i) => {
			if (ch !== "&") return null;
			const prev = command[i - 1];
			const next = command[i + 1];
			if (next === "&") return null; // `&&`: its own rule (skipping the pair is below)
			if (prev === "&") return null;
			if (prev === ">" || prev === "<") return null;
			if (d !== "cmd" && d !== "pwsh" && next === ">") return null; // &>file (bash)
			return "amp";
		}) === "amp"
	);
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
		if (d === "posix" && ch === "$" && (command[i + 1] === "'" || command[i + 1] === '"'))
			return "dollar-quote";
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

const NEWLINE_REASON =
	"Write the file alone: cat > .tmp/x.py << 'EOF' then the lines then EOF, and run it in a separate run_command call (no cd/&&, nothing after EOF). A new line outside quotes starts another command";

const HEREDOC_FORM_REASON =
	"Use exactly: cat > .tmp/x.py << 'EOF' then the lines then EOF. The delimiter must be quoted and the target a relative path inside the project (no .., no leading /). A heredoc into a shell or interpreter is not allowed";

/** A relative project path: no leading / or ~, no .. segment, no expansion, quote, glob or space characters. */
const PROJECT_REL_PATH =
	/^(?!~)(?!\/)(?:(?!\.\.(?:\/|$))[A-Za-z0-9_.@+=,-]+\/)*(?!\.\.$)[A-Za-z0-9_.@+=,-]+$/;

/**
 * The only heredoc form accepted: `cat > PATH << 'WORD'` or `cat << 'WORD' > PATH`
 * (also `>>` and `<<-`), delimiter quoted so the body is never expanded, PATH
 * relative and inside the project. Anything else (a shell or interpreter reading
 * the body, a pipe, a second redirect) is refused.
 */
function isQuotedHeredocFileWrite(head: string, word: string): boolean {
	// Blanks are space and tab only: \\s also matches NBSP, VT and FF, which sh reads as word characters.
	const h = head.replace(/^[ \t]+|[ \t]+$/g, "");
	const marker = `<<-?[ \\t]*(?<q>['"])${word}\\k<q>`;
	const a = new RegExp(`^cat[ \\t]+>>?[ \\t]*([^ \\t]+)[ \\t]+${marker}$`).exec(h);
	const b = new RegExp(`^cat[ \\t]+${marker}[ \\t]+>>?[ \\t]*([^ \\t]+)$`).exec(h);
	const target = a ? a[1] : b ? b[2] : null;
	if (target === null || !PROJECT_REL_PATH.test(target)) return false;
	// Hooks and keys: a write there is code execution or access later, not a project file.
	return !target.split("/").some((seg) => /^\.(git|ssh)$/i.test(seg));
}

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
	/** An unquoted word-start `#` is followed by a quote mark or line break: bash may read it as a comment, so the quote scan cannot be trusted. */
	commentAmbiguous: boolean;
	/** An unquoted newline or carriage return, outside the quotes: a second command on the next line. */
	lineBreak: boolean;
	/** A heredoc marker found outside quotes; the scan stopped at the end of its line. */
	heredoc?: { word: string; dash: boolean };
	/** Index just past the scanned head (the newline that ends a heredoc line, else the command length). */
	headEnd: number;
}

/**
 * POSIX quote scan (#3879). `;`, `&&`, `||` inside quotes are data, and `$(`,
 * `<(`, `>(` or a backtick inside SINGLE quotes is data; inside double quotes
 * the caller keeps refusing all of those, exactly as for `$(`. A backslash only
 * escapes a quote mark, `;` (#3932) or another backslash here, so `\;`, `\$(`
 * and `\<(` stay refused as before.
 * An unquoted `$'...'` (ANSI-C) span with a backslash in it is refused: bash
 * ends it differently from a plain quote, and a wrong guess hides a command.
 * `#` is NOT treated as a comment start (8SO round 3): comment skipping was a
 * recurring bypass (`\;#`, `${x:- #}`), so the rest of the line is always scanned
 * and a comment containing `;`, `&&` or a stray quote is refused, as on main. An
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
	let commentAmbiguous = false;
	let escapedDollarAt = -1;
	/** Index of the character an unquoted backslash just escaped; an escaped `<` starts no heredoc. */
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
		// Unquoted, a backslash always takes the next character (bash).
		if (ch === "\\") escapedAt = i + 1;
		if (
			ch === "\\" &&
			(command[i + 1] === '"' ||
				command[i + 1] === "'" ||
				command[i + 1] === "\\" ||
				command[i + 1] === ";")
		) {
			i++;
			continue;
		}
		if (
			ch === "<" &&
			!heredoc &&
			command[i + 1] === "<" &&
			command[i - 1] !== "<" &&
			command[i + 2] !== "<" &&
			escapedAt !== i
		) {
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
		if (
			ch === "#" &&
			(i === 0 || (escapedAt !== i - 1 && /\s/.test(command[i - 1]))) &&
			/['"\n\r]/.test(command.slice(i))
		)
			commentAmbiguous = true;
		if (ch === "\\" && command[i + 1] === "$") escapedDollarAt = i + 1;
		if ((ch === "'" || ch === '"') && command[i - 1] === "$" && escapedDollarAt !== i - 1)
			dollarQuote = true;
		if (ch === "'") {
			mode =
				command[i - 1] === "$" && command[i - 2] !== "$" && command[i - 2] !== "\\"
					? "ansi"
					: "single";
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
	return {
		balanced: mode === "none",
		outside,
		doubled,
		ansiEscape,
		dollarQuote,
		commentAmbiguous,
		lineBreak,
		heredoc,
		headEnd,
	};
}

/**
 * Validate a command before it reaches the shell.
 * Returns { safe: false, reason } for a blocked command. `kind` is the shell
 * that will parse it; omitted, it follows the resolved shell on this machine.
 *
 * POSIX shells (also Git Bash on Windows) get the quote-aware scan from #3879:
 * text inside quotes is data. cmd.exe and PowerShell keep the strict dialect
 * walk, where a quote never hides a line break and PowerShell evaluates
 * (...), {...} and friends outside quotes.
 */
export function sanitizeShellCommand(
	command: string,
	platform: NodeJS.Platform = process.platform,
	kind?: ShellKind | "posix",
): ShellSanitizeResult {
	const d = dialectFor(platform, kind);
	// Encoded and expansion-trick forms hide the real command from every later check (8SO).
	const hidden = refuseHiddenCommand(command, d);
	if (hidden) return hidden;
	return d === "posix"
		? sanitizePosix(command, platform, kind)
		: sanitizeStrict(command, d, platform, kind);
}

const ENCODED_COMMAND = "encodedcommand";
const ENCODED_ARGUMENTS = "encodedarguments";
/** powershell / pwsh as a program word (also a path ending in powershell.exe), not a longer name. */
const INVOKES_PWSH = /(^|[^A-Za-z0-9_.-])(powershell|pwsh)(\.exe)?(?![A-Za-z0-9_-])/i;
const INVOKES_CMD = /(^|[^A-Za-z0-9_.-])cmd(\.exe)?(?![A-Za-z0-9_-])/i;

/**
 * True when `token` (quotes already stripped) is PowerShell's -EncodedCommand
 * or any prefix PowerShell accepts for it: -e, -ec, -en, -enc, -enco ... up to
 * the full name, case-insensitive, dash or (for powershell.exe) slash, with an
 * optional `:value`. `-Encoding` is not a prefix of it, so Out-File -Encoding
 * is untouched. -EncodedArguments (the sibling) is refused from -encodeda on.
 */
function isEncodedCommandFlag(token: string, allowSlash: boolean): boolean {
	const m = /^([-\u2013\u2014\u2015]|\/)([A-Za-z]+)(?:[:=].*)?$/.exec(token);
	if (!m) return false;
	if (m[1] === "/" && !allowSlash) return false;
	const w = m[2].toLowerCase();
	if (w === "ec" || ENCODED_COMMAND.startsWith(w)) return true; // -ec is PowerShell's own alias, not a prefix
	return w.length >= 8 && ENCODED_ARGUMENTS.startsWith(w);
}

/** A token that reads as a parameter: starts with - or /, or an en dash, em dash or horizontal bar. */
const FLAG_LIKE = /^[-/\u2013\u2014\u2015]/;
/** Characters that expand, escape or vanish inside a PowerShell parameter name, so it cannot be read as written. */
const FLAG_HIDING_CHARS = /[$%!^\\'"`]/;

function refuseHiddenCommand(command: string, d: Dialect): ShellSanitizeResult | null {
	const invokesPwsh = INVOKES_PWSH.test(command);
	if (d === "pwsh" || invokesPwsh) {
		const raw = command.split(/\s+/).filter((t) => t !== "");
		// PowerShell drops quotes, ^ and \ inside a parameter name (-"enc", -e""nc, -^enc, -\enc), so strip them all.
		const tokens = raw.map((t) => t.replace(/['"^\\]/g, ""));
		// Inside the PowerShell host only the dash form is a parameter; powershell.exe also takes /.
		const smuggled = raw.some((t) => FLAG_LIKE.test(t) && FLAG_HIDING_CHARS.test(t));
		if (smuggled || tokens.some((t) => isEncodedCommandFlag(t, invokesPwsh))) {
			return {
				safe: false,
				reason:
					"PowerShell -EncodedCommand (and its abbreviations -e, -ec, -enc ...) hides the command from the check and is not allowed (a parameter name that holds quotes, ^, \\ or $ is refused too). Pass the command as plain text",
			};
		}
	}
	if (d === "cmd" || INVOKES_CMD.test(command)) {
		// cmd.exe expands % and ! inside double quotes too, and drops ^ before it parses, so scan both forms.
		for (const text of [command, command.replace(/\^/g, "")]) {
			if (/%[^%:\s"]+:[^%\r\n]*%/.test(text)) {
				return {
					safe: false,
					reason:
						"cmd.exe %VAR:~n,m% and %VAR:a=b% expansion builds text the check cannot read and is not allowed. Write the value out",
				};
			}
			if (/![^!\s"]+!/.test(text)) {
				return {
					safe: false,
					reason:
						"cmd.exe delayed expansion !VAR! may be on and builds text the check cannot read, so it is not allowed. Write the value out",
				};
			}
		}
	}
	return null;
}

function sanitizePosix(
	command: string,
	platform: NodeJS.Platform,
	kind?: ShellKind | "posix",
): ShellSanitizeResult {
	// Text inside quotes is data (#3879).
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
			reason:
				"A $'...' string with a backslash cannot be checked. Use plain quotes, or put the text in a file",
		};
	}
	if (scan.commentAmbiguous) {
		return {
			safe: false,
			reason:
				"A # followed by a quote mark or new line cannot be checked. Remove the comment, or put the steps in a script file",
		};
	}
	if (scan.lineBreak) {
		return { safe: false, reason: NEWLINE_REASON };
	}
	// Bash still expands these inside double quotes. Process substitution is
	// held to the same rule as $( so the two cannot drift apart.
	if (scan.doubled.some((q) => /\$\(/.test(q))) {
		return { safe: false, reason: "Command substitution $(...) is not allowed" };
	}
	if (scan.doubled.some((q) => PROCESS_SUBSTITUTION.test(q))) {
		return { safe: false, reason: PROCESS_SUBSTITUTION_REASON };
	}
	if (scan.doubled.some((q) => q.includes("`"))) {
		return { safe: false, reason: "Command substitution via backticks is not allowed" };
	}
	let body = "";
	if (scan.heredoc) {
		// The marker is real (outside quotes). Its body must end with its own
		// terminator line, and nothing may follow that line: that would be another command.
		const lines = command.slice(scan.headEnd + 1).split("\n");
		const word = scan.heredoc.word;
		if (!isQuotedHeredocFileWrite(command.slice(0, scan.headEnd), word))
			return { safe: false, reason: HEREDOC_FORM_REASON };
		const end =
			scan.headEnd >= command.length
				? -1
				: lines.findIndex((l) => (scan.heredoc?.dash ? l.replace(/^\t+/, "") : l) === word);
		if (end < 0) return { safe: false, reason: HEREDOC_REASON };
		if (!/^[ \t\n]*$/.test(lines.slice(end + 1).join("\n")))
			return { safe: false, reason: NEWLINE_REASON };
		body = `\n${lines.slice(0, end + 1).join("\n")}`;
	}
	const text = scan.outside + body;

	// Bash 4.4+ prompt-expands ${x@P}, which runs command substitution held in x (8SO hardening).
	if (/@P\}/.test(text) || /@P\}/.test(command)) {
		return { safe: false, reason: "The ${var@P} expansion is not allowed" };
	}

	if (/\$\(/.test(text)) {
		return { safe: false, reason: "Command substitution $(...) is not allowed" };
	}
	if (PROCESS_SUBSTITUTION.test(text)) {
		return { safe: false, reason: PROCESS_SUBSTITUTION_REASON };
	}
	if (/`/.test(text)) {
		return { safe: false, reason: "Command substitution via backticks is not allowed" };
	}

	// Only an unquoted `;` blocks (#3879, #3932).
	if (/;/.test(text)) {
		return {
			safe: false,
			reason: "Semicolon command chaining is not allowed. Use separate run_command calls instead",
		};
	}

	// Bash $'...' and $"..." quote differently from plain quotes (#3932, 8SO): refuse any unquoted one.
	if (scan.dollarQuote) {
		return {
			safe: false,
			reason: "Bash $'...' and $\"...\" quoting is not allowed. Use plain quotes instead",
		};
	}

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

	if (hasUnquotedAmpersand(command, platform, kind)) {
		return {
			safe: false,
			reason:
				"Command chaining or background execution with & is not allowed. Use separate run_command calls instead",
		};
	}

	return { safe: true };
}

/** cmd.exe: a `;` anywhere counts, quotes do not hide it; only a `^` escape does. */
function cmdHasSemicolon(command: string): boolean {
	for (let i = 0; i < command.length; i++) {
		if (command[i] === "^") i++;
		else if (command[i] === ";") return true;
	}
	return false;
}

/** cmd.exe and PowerShell: the strict dialect walk over the whole line. */
function sanitizeStrict(
	command: string,
	d: Dialect,
	platform: NodeJS.Platform,
	kind?: ShellKind | "posix",
): ShellSanitizeResult {
	// Block command substitution ($(...) and backticks) and process substitution (<(...), >(...))
	if (/\$\(/.test(command)) {
		return {
			safe: false,
			reason: "Command substitution $(...) is not allowed",
		};
	}
	if (PROCESS_SUBSTITUTION.test(command)) {
		return { safe: false, reason: PROCESS_SUBSTITUTION_REASON };
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
			reason:
				"A line break starts a second command and is not allowed. Use separate run_command calls instead",
		};
	}

	// Block semicolon chaining: ; cmd. A `;` inside quotes is data, not a
	// separator (e.g. magick -annotate 'a;b'), so only an unquoted one blocks.
	// cmd.exe keeps the strict whole-line rule: a `;` blocks, quoted or not, unless `^`-escaped.
	const semi =
		d === "cmd" ? (cmdHasSemicolon(command) ? "semicolon" : null) : scanSemicolon(command, d);
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
