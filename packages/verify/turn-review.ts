/**
 * Turn-end side reviewer (#3419), deterministic slice.
 *
 * Reads one finished agent turn (the prompt, the tool-call log, the final
 * reply) and says, in at most three short plain lines, what the reply left
 * unsaid:
 *   1. files changed that the prompt never named,
 *   2. tests skipped, failing, or not run after the last code edit,
 *   3. tool errors or warnings the final reply does not mention.
 *
 * Pure: no I/O, no model call. It never blocks and never changes the turn's
 * result; the caller only displays what it returns. Every line is passed
 * through the tool-output secret scanner before it leaves this module.
 * A clean turn returns [] so the reviewer stays silent.
 *
 * Concept only (a maker-checker note at turn end); no third-party code.
 */

import * as path from "node:path";
import { scrub } from "../eight/secret-scanner";

/** One tool call as the agent's per-turn ledger records it. */
export interface TurnReviewToolCall {
	name: string;
	args?: Record<string, unknown>;
	success: boolean;
	/** Tool output or error string (the agent keeps the first 500 chars). */
	result?: string;
}

export interface TurnReviewInput {
	prompt: string;
	toolCalls: TurnReviewToolCall[];
	reply: string;
	/** Used to turn absolute tool paths into the repo-relative form. */
	workingDirectory?: string;
}

export const MAX_REVIEW_LINES = 3;
const MAX_LINE = 160;

/** The flag is exactly "1". Anything else ("true", "0", unset) is off. */
export function turnReviewEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return env.EIGHT_TURN_REVIEW === "1";
}

const MUTATING_TOOLS = new Set([
	"write_file",
	"edit_file",
	"delete_file",
	"notebook_edit_cell",
	"notebook_insert_cell",
	"notebook_delete_cell",
]);

const TEST_COMMAND =
	/(?:^|[\s;&|(])(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test\b|bunx?\s+test\b|npx\s+(?:jest|vitest|mocha)\b|jest\b|vitest\b|pytest\b|mocha\b|go\s+test\b|cargo\s+test\b)/;

/**
 * Only source-code edits call for a test run after them. Docs, config and
 * data files (README.md, package.json, a crontab, an .env) do not.
 */
const CODE_FILE =
	/\.(?:[cm]?[jt]sx?|py|go|rs|swift|rb|java|kts?|c|cc|cpp|h|hpp|cs|php|scala|exs?|lua|dart|vue|svelte)$/i;

const SKIP_ADDED =
	/\b(?:test|it|describe)\.(?:skip|todo)\s*\(|\bxit\s*\(|\bxdescribe\s*\(|@pytest\.mark\.(?:skip|xfail)/;
// A runner summary line that is only a count: bun prints " 1 skip" and
// " 2 todo" on lines of their own. Anchored to the whole line so a test
// name such as "renders 3 todo items" never counts.
const SKIP_REPORTED = /^[ \t]*([1-9]\d*)[ \t]+(?:skip(?:ped)?|todo)[ \t]*$/m;
// Terminal colour codes in captured output (ESC [ ... m).
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
// A guard refused the command: it never ran, so it is not a test run.
const NOT_RUN = /^\[[A-Z0-9_ ]*(?:BLOCKED|DENIED)\]/;
const EXIT_NONZERO = /^Exit code ([1-9]\d*)/;
const WARNING = /\bwarn(?:ing)?\b[:\]]/i;
/**
 * Commands whose exit 1 is an answer, not a failure: grep/rg found no
 * match, test/[ evaluated false, git diff --quiet saw a difference.
 */
const PROBE_COMMAND =
	/^\s*(?:[A-Z_][A-Z0-9_]*=\S*\s+)*(?:grep|egrep|fgrep|rg|test|\[\[?|git\s+grep|git\s+diff\b[^\n]*\s--(?:quiet|exit-code)\b)(?:\s|$)/;
/** Only this much of any one input is scanned, so a huge value stays cheap. */
const SCAN_LIMIT = 4000;
const MAX_TOKEN = 256;
/** File extensions a bare name (no slash) must carry to count as a path. */
const NAMED_FILE_EXT =
	/\.(?:[cm]?[jt]sx?|py|go|rs|swift|rb|java|kts?|c|cc|cpp|h|hpp|cs|php|scala|exs?|lua|dart|vue|svelte|md|mdx|txt|rst|json|jsonc|ya?ml|toml|ini|env|lock|sh|bash|zsh|html|css|scss|sql|csv|xml|svg|ipynb|gradle|plist)$/i;
const REPLY_ADMITS =
	/\b(?:error|errors|fail(?:ed|s|ing|ure)?|block(?:ed)?|warn(?:ing|ings)?|could not|couldn't|cannot|can't|unable|did not|didn't|not run|skipp?ed)\b/i;

const BRANCH_PREFIX =
	/^(?:feat|feature|fix|bugfix|hotfix|docs|chore|refactor|perf|ci|build|release|origin|refs)\//i;

function argPath(args: Record<string, unknown> | undefined): string | null {
	if (!args) return null;
	for (const key of ["path", "file_path", "filePath", "notebook_path"]) {
		const v = args[key];
		// An over-long "path" is not one a person would read; skip it to stay cheap.
		if (typeof v === "string" && v.trim() && v.length <= 1024) return v.trim();
	}
	return null;
}

function relPath(p: string, cwd: string | undefined): string {
	const norm = p.replace(/\\/g, "/");
	if (cwd && path.isAbsolute(norm)) {
		const rel = path.relative(cwd, norm).replace(/\\/g, "/");
		if (rel && !rel.startsWith("..")) return rel;
	}
	return norm.replace(/^\.\//, "");
}

/**
 * Path-like tokens the prompt names: "src/a.ts", "a.ts", "packages/verify/".
 *
 * Linear by construction: only the first SCAN_LIMIT characters are read, the
 * text is split on whitespace first, and a token over MAX_TOKEN characters is
 * skipped, so no regex ever runs over a long unbroken run.
 */
export function promptPaths(prompt: string): string[] {
	const out = new Set<string>();
	const words = prompt.slice(0, SCAN_LIMIT).split(/\s+/);
	words.forEach((word, i) => {
		if (!word || word.length > MAX_TOKEN) return;
		const token = word
			.replace(/^[`'"([{<]+/, "")
			.replace(/[`'")\]}>,;:!?]+$/, "")
			.replace(/\.+$/, "")
			.replace(/^\.\//, "");
		if (!token || token.includes("://")) return;
		const hasSlash = token.includes("/");
		const hasExt = NAMED_FILE_EXT.test(token);
		// A bare word needs a known file extension; "e.g", "1.2.3" and "v2" do not.
		if (!hasSlash && !hasExt) return;
		// Product names, not files: "Next.js", "Node.js", "Vue.js".
		if (!hasSlash && /^[A-Z][A-Za-z]*\.js$/.test(token)) return;
		// A branch name ("a new branch called feat/todo-done") is not a file
		// scope. Without this a prompt naming only its branch would flag every
		// changed file as not asked for.
		const before = words.slice(Math.max(0, i - 3), i).join(" ");
		const looksLikeBranch = BRANCH_PREFIX.test(token) && !token.endsWith("/") && !hasExt;
		if (/\bbranch\b/i.test(before) || looksLikeBranch) return;
		out.add(token);
	});
	return [...out];
}

function stem(file: string): string {
	return path
		.basename(file)
		.replace(/\.[A-Za-z0-9]+$/, "")
		.replace(/\.(?:test|spec)$/, "")
		.toLowerCase();
}

function isNamed(rel: string, named: string[]): boolean {
	const base = path.basename(rel).toLowerCase();
	const relLower = rel.toLowerCase();
	for (const n of named) {
		const nl = n.toLowerCase();
		if (nl.endsWith("/")) {
			if (relLower.startsWith(nl) || relLower.includes(`/${nl}`)) return true;
			continue;
		}
		if (relLower === nl || relLower.endsWith(`/${nl}`)) return true;
		if (base === path.basename(nl)) return true;
		// A test file for a named source file was asked for implicitly.
		if (/\.(?:test|spec)\./.test(base) && stem(rel) === stem(nl)) return true;
	}
	return false;
}

function listNames(items: string[], max = 3): string {
	const shown = items.slice(0, max).join(", ");
	return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/** The command a run_command call ran, scrubbed then clipped, for naming it. */
function commandLabel(call: TurnReviewToolCall): string {
	const cmd = typeof call.args?.command === "string" ? call.args.command : "";
	// Scrub before clipping: a cut-off secret no longer matches its pattern.
	const one = scrub(cmd.slice(0, SCAN_LIMIT).replace(/\s+/g, " ").trim()).scrubbed;
	return one.length > 40 ? `${one.slice(0, 37)}...` : one;
}

/** How a call is named in a line: the tool, plus the command for run_command. Never its output. */
function label(call: TurnReviewToolCall): string {
	const cmd = call.name === "run_command" ? commandLabel(call) : "";
	return cmd ? `run_command \`${cmd}\`` : call.name;
}

function isProbe(call: TurnReviewToolCall): boolean {
	return (
		call.name === "run_command" &&
		typeof call.args?.command === "string" &&
		PROBE_COMMAND.test(call.args.command.slice(0, SCAN_LIMIT))
	);
}

function isFailure(call: TurnReviewToolCall): boolean {
	if (!call.success) return true;
	const exit = EXIT_NONZERO.exec((call.result ?? "").trimStart());
	if (!exit) return false;
	// grep with no match, a false test: exit 1 is the answer, not a failure.
	return !(exit[1] === "1" && isProbe(call));
}

function unaskedFiles(input: TurnReviewInput, changed: string[]): string | null {
	const named = promptPaths(input.prompt);
	// A prompt that names no path gives no scope to compare against.
	if (named.length === 0 || changed.length === 0) return null;
	const extra = changed.filter((f) => !isNamed(f, named));
	if (extra.length === 0) return null;
	return `Not asked for: changed ${listNames(extra)} (prompt named ${listNames(named)}).`;
}

function testGaps(input: TurnReviewInput, changedCodeIdx: Map<string, number>): string | null {
	const calls = input.toolCalls;
	const parts: string[] = [];

	// Skips added by this turn's edits.
	const skipAdded = new Set<string>();
	calls.forEach((c) => {
		if (!c.success || !MUTATING_TOOLS.has(c.name)) return;
		const body = [c.args?.content, c.args?.newText, c.args?.new_string, c.args?.source]
			.filter((v): v is string => typeof v === "string")
			.join("\n");
		const p = argPath(c.args);
		if (p && SKIP_ADDED.test(body)) skipAdded.add(relPath(p, input.workingDirectory));
	});
	if (skipAdded.size > 0) parts.push(`a skipped test was added in ${listNames([...skipAdded])}`);

	let lastTest = -1;
	calls.forEach((c, i) => {
		if (
			c.name === "run_command" &&
			typeof c.args?.command === "string" &&
			TEST_COMMAND.test(c.args.command.slice(0, SCAN_LIMIT)) &&
			!NOT_RUN.test((c.result ?? "").trimStart())
		) {
			lastTest = i;
		}
	});

	if (changedCodeIdx.size > 0) {
		if (lastTest === -1) {
			parts.push(`no test command ran after editing ${listNames([...changedCodeIdx.keys()])}`);
		} else {
			const after = [...changedCodeIdx.entries()].filter(([, i]) => i > lastTest).map(([f]) => f);
			if (after.length > 0) parts.push(`${listNames(after)} changed after the last test run`);
		}
	}

	if (lastTest !== -1) {
		const last = calls[lastTest];
		const out = last.result ?? "";
		const exit = EXIT_NONZERO.exec(out.trimStart());
		if (isFailure(last)) {
			parts.push(`the last test run failed${exit ? ` (exit ${exit[1]})` : ""}`);
		}
		const skipped = SKIP_REPORTED.exec(out.slice(0, SCAN_LIMIT).replace(ANSI, ""));
		if (skipped) parts.push(`the last test run reported ${skipped[1]} skipped`);
	}

	if (parts.length === 0) return null;
	const joined = parts.join("; ");
	return `Tests: ${joined.charAt(0).toLowerCase()}${joined.slice(1)}.`;
}

function unmentionedProblems(input: TurnReviewInput): string | null {
	if (REPLY_ADMITS.test(input.reply.slice(0, SCAN_LIMIT * 4))) return null;
	const calls = input.toolCalls;
	const problems: string[] = [];
	calls.forEach((c, i) => {
		// Test runs are judged by the Tests line, not here.
		if (
			c.name === "run_command" &&
			typeof c.args?.command === "string" &&
			TEST_COMMAND.test(c.args.command.slice(0, SCAN_LIMIT))
		)
			return;
		if (isFailure(c)) {
			// Recovered: a later call of the same tool succeeded.
			const recovered = calls
				.slice(i + 1)
				.some((later) => later.name === c.name && !isFailure(later));
			if (!recovered) problems.push(`${label(c)} failed`);
			return;
		}
		// Warnings only from commands the agent ran: a file it read or a search
		// it made may contain the word without anything being wrong.
		const out = (c.result ?? "").slice(0, SCAN_LIMIT).replace(ANSI, "");
		if (c.name === "run_command" && WARNING.test(out))
			problems.push(`${label(c)} printed a warning`);
	});
	if (problems.length === 0) return null;
	const shown = problems.slice(0, 2).join("; ");
	const more = problems.length > 2 ? `; and ${problems.length - 2} more` : "";
	return `Not in the reply: ${shown}${more}.`;
}

function clip(line: string): string {
	return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 3)}...` : line;
}

/**
 * Review one finished turn. Returns at most three scrubbed lines, or [] when
 * there is nothing the reply left unsaid. Never throws on malformed input.
 */
export function reviewTurn(input: TurnReviewInput): string[] {
	try {
		const changed: string[] = [];
		const changedCodeIdx = new Map<string, number>();
		input.toolCalls.forEach((c, i) => {
			if (!c.success || !MUTATING_TOOLS.has(c.name)) return;
			const p = argPath(c.args);
			if (!p) return;
			const rel = relPath(p, input.workingDirectory);
			if (!changed.includes(rel)) changed.push(rel);
			if (CODE_FILE.test(rel)) {
				changedCodeIdx.delete(rel); // keep insertion order = last edit order
				changedCodeIdx.set(rel, i);
			}
		});

		const lines = [
			unaskedFiles(input, changed),
			testGaps(input, changedCodeIdx),
			unmentionedProblems(input),
		]
			.filter((l): l is string => l !== null)
			.slice(0, MAX_REVIEW_LINES);
		return lines.map((l) => clip(scrub(l).scrubbed));
	} catch {
		// The reviewer is advisory; a bug in it must never surface in the turn.
		return [];
	}
}
