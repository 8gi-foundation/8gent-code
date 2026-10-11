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
 *   2. the task asked for a commit and `git status --porcelain` is not empty;
 *   3. the task asked to run/pass the tests and no run_command mentioned a test runner.
 * Any miss becomes ONE nudge (the caller sends it at most once per turn). Never blocks.
 * Only turns that did something (an action tool succeeded) are checked. On by default (no
 * regression across packages/eight tests); EIGHT_COMPLETION_SELFCHECK=0 turns it off.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { ACTION_TOOLS, type ToolLedgerEntry } from "./honesty";

type Env = Record<string, string | undefined>;

export function completionSelfCheckEnabled(env: Env = process.env): boolean {
	return env.EIGHT_COMPLETION_SELFCHECK?.trim() !== "0";
}

const FILE_VERB = /\b(?:creat\w*|writ\w*|sav\w*|generat\w*|produc\w*|export\w*|render\w*|output)\b/i;
const FILE_TOKEN = /[`"']?((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z][A-Za-z0-9]{0,5})[`"']?/g;
const TEST_ASK =
	/\b(?:run|runs|running|pass|passes|passing)\b[^.\n]{0,40}\b(?:tests?|test suite)\b|\btests? (?:pass|must pass|should pass)\b/i;
const TEST_RUNNER = /\b(?:test|pytest|jest|vitest|mocha|cargo test|go test|rspec|phpunit)\b/i;
const COMMIT_ASK = /\bcommit\b/i;
const NO_COMMIT = /\b(?:do not|don't|dont|never|without|no)\s+(?:\w+\s+)?commit/i;

/** Files named in a sentence that has a creating verb. Bare version numbers and urls are skipped. */
export function deliverableFiles(task: string): string[] {
	const out = new Set<string>();
	for (const sentence of task.split(/(?<=[.!?\n])\s+/)) {
		if (!FILE_VERB.test(sentence)) continue;
		for (const m of sentence.matchAll(FILE_TOKEN)) {
			const f = m[1];
			if (/^\d+(\.\d+)+$/.test(f) || /^(?:e\.g|i\.e)\./i.test(f) || /^https?:/.test(f)) continue;
			if (/\.(?:com|org|io|dev|net|app)$/i.test(f) && !f.includes("/")) continue;
			out.add(f);
		}
	}
	return [...out].slice(0, 10);
}

function gitDirty(cwd: string): string[] | null {
	try {
		const out = execFileSync("git", ["status", "--porcelain"], {
			cwd,
			encoding: "utf8",
			timeout: 5000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.split("\n").filter(Boolean).slice(0, 10);
	} catch {
		return null; // not a repo, or git missing: nothing to say
	}
}

/** The one nudge to send before the turn ends, or null when the stated deliverables hold. */
export function completionSelfCheckNudge(opts: {
	task: string;
	cwd: string;
	ledger: readonly ToolLedgerEntry[];
	env?: Env;
}): string | null {
	if (!completionSelfCheckEnabled(opts.env)) return null;
	const { task, cwd, ledger } = opts;
	if (!ledger.some((e) => e.success && ACTION_TOOLS.has(e.name))) return null;
	const misses: string[] = [];
	const missing = deliverableFiles(task).filter(
		(f) => !existsSync(path.isAbsolute(f) ? f : path.join(cwd, f)),
	);
	if (missing.length) misses.push(`these files the task names do not exist: ${missing.join(", ")}`);
	if (COMMIT_ASK.test(task) && !NO_COMMIT.test(task)) {
		const dirty = gitDirty(cwd);
		if (dirty?.length)
			misses.push(
				`the task asks for a commit but git status is not clean (${dirty.join("; ")}); commit or remove these`,
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
