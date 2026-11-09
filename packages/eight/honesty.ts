/**
 * 8gent - Agentic Honesty gate (Law 1: no fabricated completion).
 *
 * The agent MUST NOT claim an action happened ("created / successful / done /
 * committed") unless a tool actually ran this turn and returned success. This
 * module gates the final response on the turn's tool ledger:
 *
 *   - If the turn made at least one SUCCESSFUL action-tool call, the reply
 *     passes through untouched.
 *   - If every action-tool call FAILED and the reply still claims completion,
 *     the reply is replaced with an honest, actionable failure report built
 *     from the real tool errors.
 *   - If NO action tool ran at all and the reply claims a concrete completed
 *     action (a file/commit that "was created"), the reply is replaced with an
 *     honest "nothing actually ran" note.
 *
 * Pure functions, no I/O - the caller (packages/eight/agent.ts) owns the
 * ledger and applies the gate on both the native tool loop and the text-tool
 * loop. See issue #2747 and the AgenticHonesty skill.
 */

import { isTestRun } from "./test-claim-gate";

/** One tool call made during the current turn. */
export interface ToolLedgerEntry {
	name: string;
	args?: Record<string, unknown>;
	success: boolean;
	/** Tool output (or error string) - used to build the honest failure report. */
	result?: string;
}

/**
 * Tools whose success a completion claim can legitimately rest on. Read-only
 * tools (read_file, list_files, web_search, ...) never justify "I created X".
 */
export const ACTION_TOOLS: ReadonlySet<string> = new Set([
	"write_file",
	"edit_file",
	"delete_file",
	"run_command",
	"git_add",
	"git_commit",
	"git_push",
	"make_pdf",
	"make_docx",
	"make_xlsx",
	"make_pptx",
	"speak",
	"render_video_deck",
	"run_computer_task",
	"desktop_click",
	"desktop_type",
	"desktop_press",
	"desktop_drag",
]);

/**
 * Detect the executor's string-shaped error results (it returns error STRINGS
 * rather than throwing for most failure modes). Mirrors the check in
 * agent.ts's tool wrappers so both paths classify results identically.
 */
export function isErrorToolResult(result: string): boolean {
	return /^(\[[A-Z_ ]*(BLOCKED|DENIED|ERROR)\]|Error:|Error running tool|Unknown tool:|Path blocked by path-guard|Path traversal blocked)/.test(
		result.trimStart(),
	);
}

// A "fileish" object: the artifacts a completion claim is usually about.
const FILEISH =
	String.raw`(?:file|files|folder|directory|dir|repo|repository|branch|commit|document|script|` +
	String.raw`\S+\.(?:txt|md|ts|tsx|js|jsx|py|json|swift|sh|zsh|yml|yaml|toml|html|css|pdf|csv))`;

/**
 * Success-claim detectors. Each pattern requires either explicit success
 * phrasing ("creation successful", "successfully created", "has been
 * created") or an action verb tied to a fileish object ("created the file",
 * "file created at ..."), so ordinary informational prose ("here is how files
 * are created on Unix") does not trip the gate.
 */
const SUCCESS_CLAIM_PATTERNS: RegExp[] = [
	/\b(?:creation|write|update|deletion|removal|commit|push|operation|task) (?:was |is )?successful\b/i,
	/\bsuccessfully (?:created|wrote|written|saved|updated|deleted|removed|committed|pushed|initiated|completed)\b/i,
	/\bhas been (?:successfully )?(?:created|written|saved|updated|deleted|removed|committed|pushed)\b/i,
	/\bhave been (?:successfully )?(?:created|written|saved|updated|deleted|removed|committed|pushed)\b/i,
	new RegExp(
		String.raw`\b(?:i|we)(?:'ve| have)? (?:just )?(?:created|wrote|written|saved|updated|deleted|committed|pushed)\b[^\n]{0,80}\b${FILEISH}\b`,
		"i",
	),
	new RegExp(
		String.raw`\b${FILEISH} (?:was |is )?(?:created|written|saved) (?:at|in|with|to)\b`,
		"i",
	),
	new RegExp(String.raw`\b(?:created|wrote|saved) (?:the |a |an )?(?:new )?${FILEISH}\b`, "i"),
	new RegExp(
		String.raw`\b${FILEISH}\b[^\n]{0,60}\b(?:created|written|saved|committed|pushed) successfully\b`,
		"i",
	),
];

/** True when the reply claims a concrete completed action. */
export function claimsCompletion(content: string): boolean {
	if (!content) return false;
	return SUCCESS_CLAIM_PATTERNS.some((p) => p.test(content));
}

/** First words of the failure reply below. Exported so no caller copies the literal. */
export const HONEST_FAILURE_PREFIX = "I could not complete that action.";

/**
 * True when a failed tool result is the harness's own permission or sandbox refusal,
 * not an outage or a bug. Bare "refused" is not a denial: "connection refused" is an outage.
 */
export function isDenialResult(result: string | undefined): boolean {
	return /\b(BLOCKED|DENIED)\b|permission denied|outside working directory|path traversal|path blocked/i.test(
		result ?? "",
	);
}

/** Reply for a success claim made after every action tool FAILED. */
export function buildHonestFailureReply(
	failed: ToolLedgerEntry[],
	workingDirectory?: string,
): string {
	const lines = failed.slice(-5).map((e) => {
		const err = (e.result ?? "unknown error").replace(/\s+/g, " ").trim().slice(0, 220);
		const argHint =
			e.args && typeof (e.args as { path?: unknown }).path === "string"
				? ` (path: ${(e.args as { path: string }).path})`
				: "";
		return `- ${e.name}${argHint} failed: ${err}`;
	});
	const sandboxHit = failed.some((e) =>
		/outside working directory|path traversal|path blocked/i.test(e.result ?? ""),
	);
	const sandboxNote =
		sandboxHit && workingDirectory
			? `\n\nI can only write inside ${workingDirectory}. Give me a path inside that directory (or change my working directory) and I will retry for real.`
			: "";
	return `${HONEST_FAILURE_PREFIX}\n\n${lines.join("\n")}\n\nNothing was written or changed on disk this turn.${sandboxNote}`;
}

/** Reply for a completion claim made with NO action tool run at all. */
export function buildNoActionReply(): string {
	return (
		"I have not actually done that yet - no tool ran this turn, so nothing changed " +
		"on disk. To do it for real I need to execute the corresponding tool (for " +
		"example write_file). Ask me to proceed and I will run it."
	);
}

// ── Action claims (break found by the daily-driver pilot) ─────────────────────
//
// Law 1 above passes a reply when ANY action tool succeeded, and its patterns
// only know "successfully committed", "has been committed" and "I committed
// <file>". So "Committed both files with the message add sub", sent with no
// tool call at all, matched nothing and reached the user as fact (qwen3.8:27b,
// git log still showed only the init commit). A claim of one specific action
// has to be backed by a successful call of that action, not by any call.

type ActionClaimKind = "commit" | "push" | "tests";

interface ActionClaim {
	kind: ActionClaimKind;
	/** Past-tense report of the action. */
	says: RegExp;
	/** The turn's ledger holds a successful call of exactly this action. */
	backed: (ledger: readonly ToolLedgerEntry[]) => boolean;
	/** Shown to the user under the reply. */
	note: string;
}

const exitedNonZero = (e: ToolLedgerEntry) => /^Exit code (?!0\b)/.test(e.result ?? "");

// ── Shell evidence ───────────────────────────────────────────────────────────

/** Split a shell line into [segment, operator-that-follows] pairs, honouring quotes. */
function shellChain(command: string): Array<{ seg: string; op: string }> {
	// A heredoc body is text, not commands.
	const text = command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, "");
	const out: Array<{ seg: string; op: string }> = [];
	let cur = "";
	let quote = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			// Inside double quotes bash drops backslash-newline; inside single quotes it stays.
			if (ch === "\\" && quote === '"' && text[i + 1] === "\n") {
				i++;
				continue;
			}
			cur += ch;
			if (ch === "\\" && quote === '"' && i + 1 < text.length) cur += text[++i];
			else if (ch === quote) quote = "";
			continue;
		}
		// Unquoted backslash-newline is a line continuation: bash removes it, so
		// `git push \<newline>--dry-run` is one command with a --dry-run argument.
		if (ch === "\\" && text[i + 1] === "\n") {
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < text.length) {
			cur += ch + text[++i];
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			cur += ch;
			continue;
		}
		// A redirection is part of its command: 2>&1, 1>&2, >&2, &>file, &>>file.
		const redirect = text.slice(i).match(/^(?:\d*>&\d*-?|&>>?)/);
		if (redirect && (ch === "&" || /\d|>/.test(ch))) {
			// A digit only starts a redirection when it ends a word: "2>&1", not "v2>&1" mid-token.
			if (!/\d/.test(ch) || /(?:^|\s)$/.test(cur)) {
				cur += redirect[0];
				i += redirect[0].length - 1;
				continue;
			}
		}
		const two = text.slice(i, i + 2);
		if (two === "&&" || two === "||") {
			out.push({ seg: cur.trim(), op: two });
			cur = "";
			i++;
		} else if (ch === ";" || ch === "|" || ch === "\n" || ch === "&") {
			out.push({ seg: cur.trim(), op: ch === "\n" ? ";" : ch });
			cur = "";
		} else cur += ch;
	}
	out.push({ seg: cur.trim(), op: "" });
	return out.filter((x) => x.seg !== "");
}

interface ShellWord {
	text: string;
	/** An unquoted-or-double-quoted `$` or a backtick: the shell, not this text, decides the value. */
	dynamic: boolean;
}

/** Words of a shell segment with their quotes removed: `'-n'` and `"--dry-run"` are real arguments. */
function shellWords(s: string): ShellWord[] {
	const words: ShellWord[] = [];
	let cur = "";
	let has = false;
	let dyn = false;
	let quote = "";
	const flush = () => {
		if (has || cur) words.push({ text: cur, dynamic: dyn });
		cur = "";
		has = false;
		dyn = false;
	};
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === "\\" && quote !== "'" && s[i + 1] === "\n") {
			i++; // line continuation: bash drops backslash-newline outside single quotes
		} else if (quote) {
			if (ch === quote) quote = "";
			else if (ch === "\\" && quote === '"' && i + 1 < s.length) cur += s[++i];
			else {
				if (quote === '"' && (ch === "$" || ch === "`")) dyn = true;
				cur += ch;
			}
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			has = true;
		} else if (ch === "\\" && i + 1 < s.length) {
			cur += s[++i];
			has = true;
		} else if (/\s/.test(ch)) {
			flush();
		} else {
			if (ch === "$" || ch === "`") dyn = true;
			cur += ch;
			has = true;
		}
	}
	flush();
	return words;
}

/**
 * Short options whose value is the next word (or the rest of this one), per subcommand.
 * commit: -m -F -C -c -t. push: -o only (on commit -o is --only and takes no value).
 */
const VALUE_SHORT: Record<string, string> = { commit: "mFCct", push: "o" };
/** Short options whose value is only ever attached: `-Skeyid`, `-uno`. A bare `-S` or `-u` takes nothing. */
const ATTACHED_SHORT: Record<string, string> = { commit: "Su", push: "" };
/** Long options that take a message, file or repo: their value is text, never a flag. */
const VALUE_LONG =
	/^--(?:message|file|reuse-message|reedit-message|template|push-option|author|date|cleanup|trailer|fixup|squash|pathspec-from-file|repo|receive-pack|exec)$/;

/**
 * True when the arguments mean "nothing was done": --dry-run (or any unambiguous
 * abbreviation, --dry) and --help/-h on any subcommand, and -n on push, bundled or
 * not (on commit -n is --no-verify). Only the values of -m, -F and friends are
 * skipped; a quoted "--dry-run" that is a real argument still counts. An argument the
 * shell would expand ($VAR, $(...), `...`, $'...') cannot be read, so it fails closed.
 */
function isNoopInvocation(args: ShellWord[], sub: string): boolean {
	const valueShort = VALUE_SHORT[sub] ?? "";
	const attachedShort = ATTACHED_SHORT[sub] ?? "";
	for (let i = 0; i < args.length; i++) {
		const w = args[i].text;
		if (w === "--") break;
		if (w.startsWith("--")) {
			const name = w.slice(2).split("=")[0];
			if (VALUE_LONG.test(`--${name}`)) {
				if (!w.includes("=")) i++;
				continue;
			}
			if (args[i].dynamic) return true;
			if (name.length >= 2 && ("dry-run".startsWith(name) || "help".startsWith(name))) return true;
			continue;
		}
		if (/^-[A-Za-z0-9]+$/.test(w) && !args[i].dynamic) {
			for (let k = 1; k < w.length; k++) {
				const c = w[k];
				if (valueShort.includes(c)) {
					if (k === w.length - 1) i++;
					break;
				}
				if (attachedShort.includes(c)) break;
				if (c === "h") return true;
				if (c === "n" && sub === "push") return true;
			}
			continue;
		}
		if (args[i].dynamic) return true;
	}
	return false;
}

/**
 * `git [global options] <sub> ...`, with the subcommand in command position,
 * and arguments that do not make it a no-op.
 */
function gitSub(seg: string, sub: string): boolean {
	const m = seg.match(
		/^(?:(?:env\s+)?(?:\w+=\S*\s+)*)git(?:\s+(?:-[cC]\s+\S+|--[\w-]+(?:=\S+)?))*\s+([\w-]+)\b(.*)$/s,
	);
	if (!m || m[1] !== sub) return false;
	return !isNoopInvocation(shellWords(m[2]), sub);
}

/**
 * A shell command whose exit status is the git subcommand's. The subcommand is
 * in command position and nothing after it masks its status: it is the last
 * command, or it is followed by && and then only && or | (`git commit && git
 * push 2>&1 | tail` exits 0 only if the commit did). `;`, `||`, `|` straight
 * after it and a trailing `&` (background) do not count.
 */
function shellGit(command: unknown, sub: string): boolean {
	if (typeof command !== "string") return false;
	const chain = shellChain(command);
	const i = chain.findIndex((c) => gitSub(c.seg, sub));
	if (i < 0) return false;
	const rest = chain.slice(i);
	if (rest.length === 1) return rest[0].op === "";
	if (rest[0].op !== "&&") return false;
	return rest
		.slice(1)
		.every((c, k, all) => (k === all.length - 1 ? c.op === "" : c.op === "&&" || c.op === "|"));
}

/** What git prints for a ref it moved, at the start of a line: `   abc1234..def5678  main -> main`, ` * [new branch]`. */
const PUSHED_REF =
	/(?:^[ \t]*[+*=\-]?[ \t]*[0-9a-f]{7,}\.\.\.?[0-9a-f]{7,}[ \t]+\S+[ \t]+->[ \t]+\S+|^[ \t]*\*[ \t]+\[new (?:branch|tag)\])/m;
/** Failure is read at the start of a line (`error:`, `fatal:`, ` ! [rejected]`), never inside a ref name like fix/error-handling. */
const PUSH_FAILED = /^(?:[ \t]*! \[|(?:remote: )?(?:error|fatal):)/im;
/** What `git commit` echoes of its own: `[main 1a2b3c4] <subject>` and the `create mode` lines. */
const COMMIT_ECHO = /^(?:\[[^\]\n]+ [0-9a-f]{7,}\].*|[ \t]*(?:create|delete|rename|copy|mode change).*)$/gm;

/** Operand words of a sink: not options, and not the value of an option that takes one. */
function sinkOperands(words: string[], valueOpts: string): number | null {
	let n = 0;
	for (let i = 1; i < words.length; i++) {
		const w = words[i];
		if (w === "--") {
			n += words.length - i - 1;
			break;
		}
		if (/^-[A-Za-z]/.test(w) && !w.startsWith("--")) {
			const c = w[1];
			if (valueOpts.includes(c) && w.length === 2) i++;
			continue;
		}
		if (w.startsWith("--")) {
			if (w === "--file" || w === "--from") return null;
			continue;
		}
		if (/^-\d+$/.test(w)) continue;
		n++;
	}
	return n;
}

/**
 * A trailing pager or logger the output is piped through. It may only read stdin: a file
 * operand (`tail /tmp/fake`, `cat - /tmp/fake`) or a rewriter (`sed`) would let the
 * command print its own "evidence". `cat` takes no arguments at all.
 */
function isPipeSink(seg: string): boolean {
	const ws = shellWords(seg);
	if (ws.some((w) => w.dynamic)) return false;
	const words = ws.map((w) => w.text).filter((w) => !/^\d*>&?\d*$/.test(w));
	const cmd = words[0];
	if (cmd === "cat") return words.length === 1;
	if (cmd === "tail" || cmd === "head") return sinkOperands(words, "nc") === 0;
	if (cmd === "less" || cmd === "more") return sinkOperands(words, "") === 0;
	if (cmd === "tee") return true;
	if (cmd === "grep") {
		// Any option that reads files (-f, -r, -R, -d recurse, --directories=recurse and their
		// long forms or abbreviations) lets the command print its own "evidence".
		const readsFiles = (w: string) => {
			if (/^-[A-Za-z]*[frRd]/.test(w) && !w.startsWith("--")) return true;
			if (!w.startsWith("--")) return false;
			const long = w.slice(2).split("=")[0];
			return long.length > 0 && ["file", "recursive", "dereference-recursive", "directories"].some((n) => n.startsWith(long));
		};
		if (words.some(readsFiles)) return false;
		const hasE = words.some((w) => /^-[A-Za-z]*e/.test(w) || w === "--regexp");
		return sinkOperands(words, "eAmBC") === (hasE ? 0 : 1);
	}
	return false;
}

/** A segment that prints nothing a push result could be mistaken for: `cd`, `git add`, `git commit`. */
function isQuietPrefix(seg: string): boolean {
	return shellWords(seg)[0]?.text === "cd" || gitSub(seg, "add") || gitSub(seg, "commit");
}

/**
 * `git push origin main 2>&1 | tail -5`: the pipe's status is tail's, so the exit
 * code proves nothing, and silence is not success (`| head -1`, `2>/dev/null`,
 * `| grep -v error` all hide a failure). Accepted only on positive evidence in the
 * push's own output: a ref-update line at the start of a line, and no failure word.
 * Nothing before the push in the chain may print but `cd`, `git add` and `git commit`
 * (joined by &&, so a failed commit stops the push), and a commit's own echo is
 * removed before the output is read.
 */
function shellGitPiped(command: unknown, sub: string, result: string): boolean {
	// A commit hook's rejection has no ref-update line to look for: push only.
	if (sub !== "push" || typeof command !== "string") return false;
	const chain = shellChain(command);
	const i = chain.findIndex((c) => gitSub(c.seg, sub));
	if (i < 0 || i === chain.length - 1) return false;
	const before = chain.slice(0, i);
	if (!before.every((c) => c.op === "&&" && isQuietPrefix(c.seg))) return false;
	// `| tail || true` only keeps the shell's own status quiet; the evidence is still the output.
	const tailEnd = chain[chain.length - 1];
	const masked = chain.length - 2 > i && /^(?:true|:)$/.test(tailEnd.seg) && chain[chain.length - 2].op === "||";
	const rest = chain.slice(i, masked ? -1 : undefined).map((c, k, all) =>
		masked && k === all.length - 1 ? { ...c, op: "" } : c,
	);
	const onlySinks = rest.every(
		(c, k, all) =>
			(k === 0 ? c.op === "|" : k === all.length - 1 ? c.op === "" : c.op === "|") &&
			(k === 0 || isPipeSink(c.seg)),
	);
	if (!onlySinks) return false;
	const own = result.replace(COMMIT_ECHO, "");
	return PUSHED_REF.test(own) && !PUSH_FAILED.test(own);
}

/** The dedicated tool, or a shell command passing `shellGit`, that succeeded with exit 0. */
function gitBacked(tool: string, sub: string, noop?: RegExp) {
	return (ledger: readonly ToolLedgerEntry[]): boolean =>
		ledger.some((e) => {
			if (!e.success || exitedNonZero(e)) return false;
			if (noop?.test(e.result ?? "")) return false;
			return (
				e.name === tool ||
				(e.name === "run_command" &&
					(shellGit(e.args?.command, sub) || shellGitPiped(e.args?.command, sub, e.result ?? "")))
			);
		});
}

const ACTION_CLAIMS: readonly ActionClaim[] = [
	{
		kind: "commit",
		says: /\b(?:committed|(?:created|made)\s+(?:the\s+|a\s+|that\s+)?commit|commit\s+(?:is\s+|was\s+)?(?:created|made|done|complete))\b/i,
		backed: gitBacked("git_commit", "commit", /nothing (?:added )?to commit|no changes added/i),
		note: "No commit was made: no git commit succeeded this turn.",
	},
	{
		kind: "push",
		says: /\b(?:pushed|push\s+(?:is\s+|was\s+)?(?:done|complete|succeeded))\b/i,
		backed: gitBacked("git_push", "push"),
		note: "Nothing was pushed: no git push succeeded this turn.",
	},
	{
		kind: "tests",
		says: /\b(?:ran|executed)\s+(?:the\s+|all\s+|your\s+|our\s+)?(?:unit\s+|full\s+)?(?:tests?|test\s+suite)\b/i,
		backed: (ledger) => ledger.some((e) => e.success && isTestRun(e)),
		note: "No tests were run: no test command ran this turn.",
	},
];

// ── Reading a reply ──────────────────────────────────────────────────────────

/** Clauses of a reply: lines, sentence ends, commas, semicolons, "but". Code blocks and quotes dropped. */
function replyClauses(text: string): string[] {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.split(/\n+/)
		.filter((line) => !/^\s*>/.test(line))
		.flatMap((line) => line.split(/(?<=[.!?:])\s+/))
		.filter((sentence) => !/\?\s*$/.test(sentence))
		.flatMap((sentence) => sentence.split(/\s*[,;]\s*|\s+(?:but|however|although|though)\s+/i))
		.map((c) => c.trim())
		.filter(Boolean);
}

// A negation, a modal or a subordinator within a few words before the verb means the clause
// is not reporting the action ("did not push", "ready to be committed", "if I committed").
const GOVERNS =
	/\b(?:not|never|no|nothing|cannot|unable|failed|without|yet|won't|can't|didn't|couldn't|wasn't|haven't|hasn't|hadn't|isn't|aren't|don't|will|would|should|could|can|may|might|must|if|once|until|unless|whether|need|needs|want|wants|please|ready|let|to|before|after|when)\b|n't\b/i;
const NEGATION_WINDOW = 3;

// Who is speaking: nobody ("Committed both files") or the reply's own voice ("I committed").
// "Alice committed ..." and "The last commit was made by ..." report someone else.
const OWN_VOICE =
	/^(?:(?:ok(?:ay)?|done|great|sure|yes|alright|good|all set|and|then|so|now|also|just|both|successfully|i|we|i've|we've|i have|we have|committed|pushed|ran|executed)\b[\s,:.!-]*)*$/i;
// "The changes have been committed": the thing acted on, then a passive auxiliary.
const OWN_PASSIVE =
	/^(?:(?:all|both|the|these|your|my|our)\s+)*(?:changes?|files?|edits?|work|everything|it|they)\s+(?:(?:has|have|had|is|are|was|were|now|all|been|successfully|just)\s+)*$/i;
// "A commit was made": only an article before the noun the claim itself names.
const ARTICLE_ONLY = /^(?:(?:a|an|the|new|this|that|my|our)\s*)+$/i;
// Credits the action to someone else ("made by Alice").
const BY_SOMEONE = /\bby\s+[A-Z]/;
// A report about the past or about a log, not about this turn.
const NOT_THIS_TURN =
	/\b(?:yesterday|previously|last\s+(?:week|month|year|night|time)|(?:on\s+)?(?:mon|tues|wednes|thurs|fri|satur|sun)day|\d{4}-\d{2}-\d{2}|in\s+the\s+previous|originally)\b/i;

/** Does this clause, spoken in the reply's own voice, report the action this turn? */
function clauseClaims(clause: string, says: RegExp): boolean {
	const m = says.exec(clause);
	if (!m) return false;
	if (NOT_THIS_TURN.test(clause)) return false;
	const before = clause.slice(0, m.index).trim();
	const nearby = before.split(/\s+/).filter(Boolean).slice(-NEGATION_WINDOW).join(" ");
	if (GOVERNS.test(nearby)) return false;
	// "Pushed to main by SSH." is the reply's own claim; only a passive subject can credit someone else.
	if (OWN_VOICE.test(before)) return true;
	if (BY_SOMEONE.test(clause)) return false;
	return OWN_PASSIVE.test(`${before} `) || ARTICLE_ONLY.test(before);
}

/** The notes for every action the reply reports that the turn's ledger does not back. */
export function unbackedActionClaims(content: string, ledger: readonly ToolLedgerEntry[]): string[] {
	if (!content) return [];
	const clauses = replyClauses(content);
	return ACTION_CLAIMS.filter(
		(c) => clauses.some((cl) => clauseClaims(cl, c.says)) && !c.backed(ledger),
	).map((c) => c.note);
}

export interface HonestyGateResult {
	content: string;
	violated: boolean;
	/** True when every failed action was a permission or sandbox refusal (#3899). */
	denied?: boolean;
	reason?: string;
}

/**
 * Law 1 gate: given the model's final reply and the turn's tool ledger,
 * return the reply to actually emit. A completion claim is only allowed
 * through when at least one action tool succeeded this turn.
 */
export function enforceAgenticHonesty(opts: {
	content: string;
	ledger: ToolLedgerEntry[];
	workingDirectory?: string;
}): HonestyGateResult {
	const { content, ledger, workingDirectory } = opts;
	const actions = ledger.filter((e) => ACTION_TOOLS.has(e.name));
	if (actions.some((e) => e.success)) {
		return actionClaimGate(content, ledger);
	}
	if (!claimsCompletion(content)) {
		return actionClaimGate(content, ledger);
	}
	const failed = actions.filter((e) => !e.success);
	if (failed.length > 0) {
		return {
			content: buildHonestFailureReply(failed, workingDirectory),
			violated: true,
			denied: failed.every((e) => isDenialResult(e.result)),
			reason: `success claim after ${failed.length} failed tool call(s) and zero successes`,
		};
	}
	return {
		content: buildNoActionReply(),
		violated: true,
		reason: "success claim with no action tool call at all",
	};
}

/** The reply stays; what the turn did not do is said under it, in plain words. */
function actionClaimGate(content: string, ledger: ToolLedgerEntry[]): HonestyGateResult {
	const notes = unbackedActionClaims(content, ledger);
	if (notes.length === 0) return { content, violated: false };
	return {
		content: `${content.trimEnd()}\n\n${notes.map((n) => `[harness] ${n}`).join("\n")}`,
		violated: true,
		reason: `action claim without a matching successful call: ${notes.join(" ")}`,
	};
}

/**
 * True when the turn's action tools were all refused by the harness, so the
 * denial is why the task did not happen. Only FAILED results count: the
 * denial text must open the result, so a successful read of a file that
 * contains "permission denied" is not a denial. One refusal the model
 * recovered from (a later action did something else) does not count either.
 */
export function denialIsCause(log: ReadonlyArray<{ name: string; result?: string }>): boolean {
	const actions = log.filter((e) => ACTION_TOOLS.has(e.name));
	const refused = (r: string | undefined) => {
		const head = (r ?? "").trimStart().slice(0, 160);
		if (/^\[[^\]]*\b(BLOCKED|DENIED)\b/.test(head)) return true;
		return /^(Error:|Path blocked|Path traversal blocked)/.test(head) && isDenialResult(head);
	};
	return actions.length > 0 && actions.every((e) => refused(e.result));
}
