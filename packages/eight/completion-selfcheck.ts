/**
 * Completion self-check (lane L18, premature completion).
 *
 * Pilot runs 9-11 Oct (l5-feature-e2e work_committed_tree_clean, media-brief-video
 * mp4_exists_and_parses) show the model answering "done" while the task's own stated
 * deliverable was not true: asked to commit, it left a dirty tree; asked to write a
 * file, the file was not there; asked to run the tests, it never ran them.
 *
 * Before a turn ends, three cheap generic facts are checked against the task text:
 *   1. a file the task says to create/write/save/generate exists on disk;
 *   2. the task asks for a commit and the turn left git entries new or changed (vs a baseline
 *      taken when the turn started; dirt that was already there is not the turn's);
 *   3. the task asked to run/pass the tests and no run_command mentioned a test runner.
 * Any miss becomes ONE nudge (the caller sends it at most once per turn). Never blocks.
 * Only turns that did something (an action tool succeeded) are checked. On by default (no
 * regression across packages/eight tests); EIGHT_COMPLETION_SELFCHECK=0 turns it off.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ACTION_TOOLS, type ToolLedgerEntry } from "./honesty";

type Env = Record<string, string | undefined>;

export function completionSelfCheckEnabled(env: Env = process.env): boolean {
	return env.EIGHT_COMPLETION_SELFCHECK?.trim() !== "0";
}

const MAX_TASK = 8192;
const FILE_VERB =
	/\b(?:create[sd]?|creating|write|writes|wrote|written|writing|save[sd]?|saving|generate[sd]?|generating|produce[sd]?|producing|export(?:s|ed|ing)?|render(?:s|ed|ing)?|output)\b/i;
const FILE_TOKEN =
	/(?<![\p{L}\p{N}_/.~-])((?:~\/|\.{0,2}\/)?[\p{L}\p{N}_@.-]+(?:\/[\p{L}\p{N}_@.-]+)*\.[A-Za-z][A-Za-z0-9]{0,5})(?![\p{L}\p{N}_/-])/gu;
const REMOVES = /\b(?:delete|remove|rename|move|rm|mv)\b/i;
const TEST_ASK =
	/\b(?:run|runs|running|pass|passes|passing)\b[^.\n]{0,40}\b(?:tests?|test suite)\b|\btests? (?:pass|must pass|should pass)\b/i;
const TEST_RUNNER = /\b(?:test|pytest|jest|vitest|mocha|cargo test|go test|rspec|phpunit)\b/i;
// An imperative ask to commit. "commit message", "the last commit" and "commit history" are not.
const COMMIT_NOT_ASK =
	/\b(?:(?:last|previous|prior|that|this|recent|latest|every|each|the)\s+commits?|commit\s+(?:message|messages|hash|history|log|id|sha))\b/gi;
const COMMIT_ASK =
	/\b(?:and\s+commit|then\s+commit|commit\s+(?:the|your|it|them|these|all|everything|changes|work)\b)/i;
const NO_COMMIT = /\b(?:do not|don't|dont|never|without|no)\s+(?:\w+\s+)?commit/i;
/** One predicate for turn start (take a git baseline?) and turn end (check it?). */
export function asksForCommit(task: string, env: Env = process.env): boolean {
	const t = task.slice(0, MAX_TASK);
	return (
		completionSelfCheckEnabled(env) && COMMIT_ASK.test(t.replace(COMMIT_NOT_ASK, " ")) && !NO_COMMIT.test(t)
	);
}

const NO_FRAMEWORK = /^[A-Z][A-Za-z]*\.js$/;

/** Files named after a creating verb, in the same sentence. URLs, framework names (Node.js) and files the sentence removes are skipped. */
export function deliverableFiles(task: string): string[] {
	const out = new Set<string>();
	// Windows paths: drive-rooted and backslash-prefixed tokens are not ours to check;
	// the rest are read with / separators.
	const text = task
		.slice(0, MAX_TASK)
		.replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
		.replace(/(?<![^\s`"'(])(?:[A-Za-z]:|\\)[^\s`"',;]*/g, " ")
		.replace(/\\/g, "/");
	for (const sentence of text.split(/(?<=[.!?\n])\s+/)) {
		const verb = FILE_VERB.exec(sentence);
		if (!verb || REMOVES.test(sentence)) continue;
		const after = sentence.slice(verb.index + verb[0].length, verb.index + verb[0].length + 160);
		for (const m of after.matchAll(FILE_TOKEN)) {
			const f = m[1];
			if (/^\d+(\.\d+)+$/.test(f) || /^(?:e\.g|i\.e)\./i.test(f)) continue;
			if (!f.includes("/") && NO_FRAMEWORK.test(f)) continue;
			if (/\.(?:com|org|io|dev|net|app)$/i.test(f) && !f.includes("/")) continue;
			out.add(f);
		}
	}
	return [...out].slice(0, 10);
}

/** Git entries now, each with size and mtime so an edit to an already-dirty file shows as changed. */
export function gitSnapshot(cwd: string): Map<string, string> | null {
	try {
		const out = execFileSync("git", ["status", "--porcelain"], {
			cwd,
			encoding: "utf8",
			timeout: 3000,
			maxBuffer: 256 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const snap = new Map<string, string>();
		for (const line of out.split("\n").filter(Boolean).slice(0, 500)) {
			let sig = "";
			try {
				const st = statSync(path.join(cwd, line.slice(3).split(" -> ").pop() ?? ""));
				sig = `${st.size}:${st.mtimeMs}`;
			} catch {}
			snap.set(line, sig);
		}
		return snap;
	} catch {
		return null; // not a repo, git missing, or too slow: nothing to say
	}
}

const quote = (line: string) => JSON.stringify(line.slice(0, 120));

/** The one nudge to send before the turn ends, or null when the stated deliverables hold. */
export function completionSelfCheckNudge(opts: {
	task: string;
	cwd: string;
	ledger: readonly ToolLedgerEntry[];
	/** git snapshot taken when the turn started; without it the commit check is skipped. */
	gitBaseline?: Map<string, string> | null;
	env?: Env;
}): string | null {
	if (!completionSelfCheckEnabled(opts.env)) return null;
	const { cwd, ledger } = opts;
	const task = opts.task.slice(0, MAX_TASK);
	if (!ledger.some((e) => e.success && ACTION_TOOLS.has(e.name))) return null;
	const removed = (f: string) =>
		ledger.some((e) => {
			const a = String(e.args?.path ?? e.args?.command ?? "");
			return a.includes(f) && (e.name === "delete_file" || /\b(?:rm|mv)\b/.test(a));
		});
	const root = path.resolve(cwd);
	const missing = deliverableFiles(task)
		.filter((f) => !removed(f))
		.map((f) => ({ f, abs: path.resolve(root, f.startsWith("~/") ? path.join(os.homedir(), f.slice(2)) : f) }))
		.filter(({ abs }) => {
			const rel = path.relative(root, abs);
			return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel); // workspace only
		})
		.filter(({ abs }) => !existsSync(abs))
		.map(({ f }) => f);
	const misses: string[] = [];
	if (missing.length) misses.push(`these files the task names do not exist: ${missing.join(", ")}`);
	if (asksForCommit(task, opts.env) && opts.gitBaseline) {
		const now = gitSnapshot(cwd);
		const left = now ? [...now].filter(([line, sig]) => opts.gitBaseline?.get(line) !== sig) : [];
		if (left.length)
			misses.push(
				`the task asks for a commit but this turn left uncommitted changes: ${left
					.slice(0, 10)
					.map(([line]) => quote(line))
					.join("; ")}`,
			);
	}
	if (TEST_ASK.test(task)) {
		const ran = ledger.some(
			(e) => e.name === "run_command" && TEST_RUNNER.test(String(e.args?.command ?? "")),
		);
		if (!ran) misses.push("the task asks for tests to be run and no test command ran this turn");
	}
	if (!misses.length) return null;
	return [
		"[SELF-CHECK] Before you say you are done, re-read the task: it is not met yet.",
		...misses.map((m) => `- ${m}`),
		'Fix these, then reply with your final summary starting with "DONE:".',
	].join("\n");
}
