/**
 * 8gent AI - Claim Check
 *
 * Compares a turn's final answer with the turn's own tool log, deterministically
 * (string inspection only, never a model call). Two narrow, checkable claims:
 *
 *  (a) Commands the user's request asked to run. A command named in backticks,
 *      or after the word "run", whose first word is a known command. If no
 *      run_command that actually executed contains it, it is unfulfilled,
 *      whether or not the answer mentions it.
 *  (b) Files the answer says it wrote. A past-tense write sentence ("Wrote X",
 *      "X was created") naming a path, or naming a requested file by its stem
 *      ("the outline was written"). If no write_file/edit_file targets it, or the
 *      last attempt was blocked or errored, it is unfulfilled.
 *
 * Evidence (Rishi pilot l2-solo-deck, 2026-09-29): run 142559 answered "DONE.
 * All requested steps are complete and backed by tool results" and listed
 * "`ls deck` -> deck.md, outline.md", but `ls deck` was blocked (chained with
 * &&) and replaced by list_files. Run 125252 had write_file blocked by TOOLG8,
 * then replied "Good, the outline was written."
 */

export type ToolLogLike = {
	name: string;
	args: Record<string, unknown>;
	result: string;
};

export type UnfulfilledClaim = {
	kind: "command" | "file";
	/** The command or path, as the request or answer wrote it. */
	target: string;
	/** Does the final answer itself mention the target? */
	mentioned: boolean;
	/** Short reason, for the model follow-up. */
	reason: string;
	/** Short note for the user and runs.jsonl, e.g. "'ls deck' was requested but never ran". */
	note: string;
};

/**
 * First words that make a span a shell command. Deliberately short: a word that
 * commonly follows "run" in English ("run tests", "run it") must not be here.
 */
export const KNOWN_COMMANDS: ReadonlySet<string> = new Set([
	"ls",
	"wc",
	"cat",
	"head",
	"tail",
	"grep",
	"rg",
	"find",
	"tree",
	"du",
	"df",
	"pwd",
	"echo",
	"mkdir",
	"diff",
	"jq",
	"curl",
	"git",
	"gh",
	"bun",
	"bunx",
	"npm",
	"npx",
	"pnpm",
	"yarn",
	"node",
	"deno",
	"tsc",
	"python",
	"python3",
	"pip",
	"pytest",
	"make",
	"cargo",
	"go",
	"docker",
	"marp",
]);

const WRITE_TOOLS: ReadonlySet<string> = new Set(["write_file", "edit_file"]);

/**
 * A tool result that means the tool did NOT do its job: the executor's own
 * "Error..." strings and every "[... BLOCKED]" gate prefix ("[BLOCKED]" from the
 * shell sanitizer, "[TOOLG8 BLOCKED]" from the policy gate). A command that ran
 * and exited non-zero ("Exit code 1:") did run, so it is not a refusal.
 */
export function isRefusedToolResult(result: string): boolean {
	return /^\s*(?:error\b|\[[^\]\n]*\bBLOCKED\b[^\]\n]*\])/i.test(result);
}

const normalizeSpaces = (s: string) => s.trim().replace(/\s+/g, " ");

function firstWord(s: string): string {
	return s.trim().split(/\s+/)[0] ?? "";
}

function isCommandLike(span: string): boolean {
	return KNOWN_COMMANDS.has(firstWord(span));
}

/**
 * Commands the user's request explicitly asked to run. Conservative:
 *  - a backticked span whose first word is a known command, and
 *  - "run X" where X starts with a known command. X ends at a clause boundary
 *    (comma, semicolon, newline, "then", a sentence-ending period). "A and B"
 *    splits into two commands only for the halves that start with a known
 *    command ("run ls deck and tell me" gives just "ls deck").
 */
export function extractRequestedCommands(request: string): string[] {
	const out: string[] = [];
	const add = (c: string) => {
		const n = normalizeSpaces(c);
		if (n && !out.includes(n)) out.push(n);
	};

	for (const m of request.matchAll(/`([^`\n]+)`/g)) {
		if (isCommandLike(m[1])) add(m[1]);
	}

	// Backticked spans are handled above; blank them so "run `ls deck`" is not
	// counted twice.
	const plain = request.replace(/`[^`\n]*`/g, "\u0000");
	const runRe = /(?:^|[^\w-])run\s+(.+?)(?=,|;|\n|\s+then\b|\.(?:\s|$)|$)/gi;
	for (const m of plain.matchAll(runRe)) {
		for (const part of m[1].split(/\s+and\s+/i)) {
			if (part.includes("\u0000")) continue;
			if (isCommandLike(part)) add(part);
		}
	}
	return out;
}

// ── Paths ─────────────────────────────────────────────────────────────────────

/** A backticked span or bare token that looks like a file path with an extension. */
function looksLikePath(s: string): boolean {
	return /^(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(s) && !/^https?:/i.test(s);
}

const BARE_PATH_RE = /(?:^|[\s(*"'])((?:\.{0,2}\/)?[\w@-][\w@.-]*(?:\/[\w@.-]+)*\.[A-Za-z][A-Za-z0-9]{0,7})(?=$|[\s),:;*"'!?]|\.(?:\s|$))/g;

/** File paths a text names, backticked first, then bare. Order of appearance kept per kind. */
export function extractPaths(text: string): string[] {
	const out: string[] = [];
	const add = (p: string) => {
		if (!out.includes(p)) out.push(p);
	};
	for (const m of text.matchAll(/`([^`\n]+)`/g)) {
		const s = m[1].trim();
		if (looksLikePath(s)) add(s);
	}
	const rest = text.replace(/`[^`\n]*`/g, " ");
	for (const m of rest.matchAll(BARE_PATH_RE)) add(m[1]);
	return out;
}

function normPath(p: string): string {
	return p.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Same file, allowing one side to be absolute (or deeper) and the other relative. */
export function samePath(a: string, b: string): boolean {
	const x = normPath(a);
	const y = normPath(b);
	if (!x || !y) return false;
	return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

// ── Claimed writes ────────────────────────────────────────────────────────────

const PAST_WRITE_RE = /\b(?:wrote|written|rewrote|rewritten|created|saved|updated|edited|modified|generated)\b/i;
const NEGATION_RE = /\b(?:not|never|no|cannot|unable|failed|blocked)\b|n't\b/i;

function sentences(text: string): string[] {
	return text
		.split(/\n+/)
		.flatMap((line) => line.split(/(?<=[.!?])\s+/))
		.map((s) => s.trim())
		.filter(Boolean);
}

function stemOf(p: string): string {
	const base = normPath(p).split("/").pop() ?? "";
	return base.replace(/\.[^.]+$/, "");
}

/**
 * Paths the answer says it wrote. A sentence counts only when it has a
 * past-tense write verb and no negation. Explicit paths in it are the claim; a
 * sentence with no explicit path claims a requested file whose stem (or
 * basename) it names as a whole word ("Good, the outline was written." claims
 * deck/outline.md when the request named deck/outline.md).
 */
export function extractClaimedWrites(answer: string, requestedFiles: string[]): string[] {
	const out: string[] = [];
	const add = (p: string) => {
		if (!out.some((q) => samePath(q, p))) out.push(p);
	};
	for (const s of sentences(answer)) {
		if (!PAST_WRITE_RE.test(s) || NEGATION_RE.test(s)) continue;
		const paths = extractPaths(s);
		if (paths.length > 0) {
			for (const p of paths) add(p);
			continue;
		}
		for (const f of requestedFiles) {
			const stem = stemOf(f);
			if (stem.length < 3) continue;
			const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			if (new RegExp(`(?:^|[^\\w/.-])${esc}(?:\\.[A-Za-z0-9]+)?(?![\\w/-])`, "i").test(s)) add(f);
		}
	}
	return out;
}

// ── Command evidence ──────────────────────────────────────────────────────────

function unquote(t: string): string {
	return t.replace(/^['"]|['"]$/g, "");
}

/** Does one executed shell segment run the requested command? */
function segmentMatches(requested: string, segment: string): boolean {
	const r = requested.trim().split(/\s+/).map(unquote);
	const e = segment.trim().split(/\s+/).map(unquote);
	if (r.length === 0 || e.length === 0) return false;
	const exe = e[0].split("/").pop();
	if (exe !== r[0]) return false;
	const rFlags = r.slice(1).filter((t) => t.startsWith("-"));
	const eFlags = new Set(e.slice(1).filter((t) => t.startsWith("-")));
	if (!rFlags.every((f) => eFlags.has(f))) return false;
	const rArgs = r.slice(1).filter((t) => !t.startsWith("-"));
	const eArgs = e.slice(1).filter((t) => !t.startsWith("-"));
	if (rArgs.length !== eArgs.length) return false;
	return rArgs.every((a, i) => samePath(a, eArgs[i]));
}

function commandRuns(requested: string, command: unknown): boolean {
	if (typeof command !== "string") return false;
	return command.split(/\s*(?:&&|\|\||;|\|)\s*/).some((seg) => segmentMatches(requested, seg));
}

function firstLine(s: string, max = 160): string {
	const line = s.trim().split("\n")[0] ?? "";
	return line.length > max ? `${line.slice(0, max)}...` : line;
}

function refusalWord(result: string): string {
	return /BLOCKED/i.test(result) ? "blocked" : "errored";
}

function mentions(answer: string, target: string): boolean {
	return normalizeSpaces(answer).includes(normalizeSpaces(target));
}

// ── The check ─────────────────────────────────────────────────────────────────

/**
 * Everything the final answer (or the request it answers) asserts that the tool
 * log does not back. Empty means nothing checkable is contradicted.
 */
export function checkClaims(opts: { request: string; answer: string; toolLog: ToolLogLike[] }): UnfulfilledClaim[] {
	const { request, answer, toolLog } = opts;
	const out: UnfulfilledClaim[] = [];

	// (a) Requested commands.
	for (const cmd of extractRequestedCommands(request)) {
		const attempts = toolLog.filter((t) => t.name === "run_command" && commandRuns(cmd, t.args?.command));
		if (attempts.some((t) => !isRefusedToolResult(t.result))) continue;
		const mentioned = mentions(answer, cmd);
		let reason = "no run_command ran it";
		let note = `'${cmd}' was requested but never ran`;
		if (attempts.length > 0) {
			const last = attempts[attempts.length - 1];
			const word = refusalWord(last.result);
			const which = attempts.length === 1 ? "its only attempt" : "its last attempt";
			reason = `${which} was ${word}: "${firstLine(last.result)}"`;
			note += ` (${which} was ${word})`;
		}
		out.push({ kind: "command", target: cmd, mentioned, reason, note });
	}

	// (b) Files the answer says it wrote.
	const requestedFiles = extractPaths(request);
	for (const path of extractClaimedWrites(answer, requestedFiles)) {
		const attempts = toolLog.filter((t) => WRITE_TOOLS.has(t.name) && typeof t.args?.path === "string" && samePath(String(t.args.path), path));
		const inRequest = requestedFiles.some((f) => samePath(f, path));
		if (attempts.length === 0) {
			// Outside the request, a file may come from a build or script: only a
			// contradicting write attempt is policed. A requested file may also be
			// produced by a command that names it (marp ... -o deck/deck.html).
			if (!inRequest) continue;
			const shell = toolLog.some(
				(t) => t.name === "run_command" && !isRefusedToolResult(t.result) && typeof t.args?.command === "string" && String(t.args.command).includes(normPath(path)),
			);
			if (shell) continue;
			out.push({
				kind: "file",
				target: path,
				mentioned: true,
				reason: "no write_file or edit_file call targeted it",
				note: `'${path}' was reported written but no write_file or edit_file targeted it`,
			});
			continue;
		}
		const last = attempts[attempts.length - 1];
		if (!isRefusedToolResult(last.result)) continue;
		const word = refusalWord(last.result);
		out.push({
			kind: "file",
			target: path,
			mentioned: true,
			reason: `the last ${last.name} to it was ${word}: "${firstLine(last.result)}"`,
			note: `'${path}' was reported written but its last write was ${word}`,
		});
	}
	return out;
}

/** The one follow-up a turn may receive when its answer contradicts the tool log. */
export function claimFollowUpMessage(unfulfilled: UnfulfilledClaim[]): string {
	const lines = unfulfilled.map((u) => {
		if (u.kind === "command") {
			return u.mentioned
				? `- Your summary says \`${u.target}\` ran, but the tool log shows it never ran (${u.reason}).`
				: `- The user asked you to run \`${u.target}\`, but the tool log shows it never ran (${u.reason}).`;
		}
		return `- Your summary says ${u.target} was written, but the tool log shows it was not (${u.reason}).`;
	});
	return [
		"Your final answer does not match the tool log:",
		...lines,
		"Do each of these now with a tool call, or correct your summary to say what was not done.",
	].join("\n");
}

/** The factual note appended to the answer the user sees, one line per item. */
export function formatHarnessNote(unfulfilled: UnfulfilledClaim[]): string {
	return unfulfilled.map((u) => `[harness] Not verified: ${u.note}.`).join("\n");
}
