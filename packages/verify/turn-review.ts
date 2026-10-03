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
const SKIP_REPORTED = /(?:^|\s)([1-9]\d*)\s+(?:skip(?:ped)?|todo)\b/im;
// Terminal colour codes in captured output (ESC [ ... m).
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
// A guard refused the command: it never ran, so it is not a test run.
const NOT_RUN = /^\[[A-Z0-9_ ]*(?:BLOCKED|DENIED)\]/;
const EXIT_NONZERO = /^Exit code ([1-9]\d*)/;
const WARNING_LINE = /^.*\bwarn(?:ing)?\b[:\]].*$/im;
const REPLY_ADMITS =
	/\b(?:error|errors|fail(?:ed|s|ing|ure)?|block(?:ed)?|warn(?:ing|ings)?|could not|couldn't|cannot|can't|unable|did not|didn't|not run|skipp?ed)\b/i;

const BRANCH_PREFIX =
	/^(?:feat|feature|fix|bugfix|hotfix|docs|chore|refactor|perf|ci|build|release|origin|refs)\//i;

function argPath(args: Record<string, unknown> | undefined): string | null {
	if (!args) return null;
	for (const key of ["path", "file_path", "filePath", "notebook_path"]) {
		const v = args[key];
		if (typeof v === "string" && v.trim()) return v.trim();
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

/** Path-like tokens the prompt names: "src/a.ts", "a.ts", "packages/verify/". */
export function promptPaths(prompt: string): string[] {
	const out = new Set<string>();
	const re =
		/[`'"(]?((?:[\w@~.-]+\/)+[\w@.-]*|[\w@-][\w@.-]*\.[A-Za-z][A-Za-z0-9]{0,5})(?=[`'")\s,;:!?]|$)/g;
	for (const m of prompt.matchAll(re)) {
		let token = m[1].replace(/[.:]+$/, "");
		if (!token || /^\d+(?:\.\d+)*$/.test(token)) continue; // version numbers
		if (/^(?:e\.g|i\.e|etc|vs)$/i.test(token)) continue;
		if (/^https?:/.test(token) || token.includes("://")) continue;
		token = token.replace(/^\.\//, "");
		// A branch name ("a new branch called feat/todo-done") is not a file
		// scope. Without this a prompt naming only its branch would flag every
		// changed file as unasked.
		const before = prompt.slice(Math.max(0, (m.index ?? 0) - 30), m.index ?? 0);
		const looksLikeBranch =
			BRANCH_PREFIX.test(token) &&
			!token.endsWith("/") &&
			!/\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(token);
		if (/\bbranch\b/i.test(before) || looksLikeBranch) continue;
		out.add(token);
	}
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

function firstLine(text: string, max = 70): string {
	const raw =
		text
			.replace(ANSI, "")
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l.length > 0) ?? "";
	// Scrub before truncating: a cut-off secret no longer matches its pattern.
	const line = scrub(raw).scrubbed;
	return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

function isFailure(call: TurnReviewToolCall): boolean {
	return !call.success || EXIT_NONZERO.test((call.result ?? "").trimStart());
}

function unaskedFiles(input: TurnReviewInput, changed: string[]): string | null {
	const named = promptPaths(input.prompt);
	// A prompt that names no path gives no scope to compare against.
	if (named.length === 0 || changed.length === 0) return null;
	const extra = changed.filter((f) => !isNamed(f, named));
	if (extra.length === 0) return null;
	return `Unasked: changed ${listNames(extra)}; the prompt named ${listNames(named)}.`;
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
			TEST_COMMAND.test(c.args.command) &&
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
		const skipped = SKIP_REPORTED.exec(out.replace(ANSI, ""));
		if (skipped) parts.push(`the last test run reported ${skipped[1]} skipped`);
	}

	if (parts.length === 0) return null;
	const joined = parts.join("; ");
	return `Tests: ${joined.charAt(0).toLowerCase()}${joined.slice(1)}.`;
}

function unmentionedProblems(input: TurnReviewInput): string | null {
	if (REPLY_ADMITS.test(input.reply)) return null;
	const calls = input.toolCalls;
	const problems: string[] = [];
	calls.forEach((c, i) => {
		// Test runs are judged by the Tests line, not here.
		if (
			c.name === "run_command" &&
			typeof c.args?.command === "string" &&
			TEST_COMMAND.test(c.args.command)
		)
			return;
		if (isFailure(c)) {
			// Recovered: a later call of the same tool succeeded.
			const recovered = calls
				.slice(i + 1)
				.some((later) => later.name === c.name && !isFailure(later));
			if (!recovered) problems.push(`${c.name} failed ("${firstLine(c.result ?? "no output")}")`);
			return;
		}
		const warn = WARNING_LINE.exec((c.result ?? "").replace(ANSI, ""));
		if (warn) problems.push(`${c.name} warned ("${firstLine(warn[0])}")`);
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
