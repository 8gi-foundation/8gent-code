/**
 * Run the project's test suite before an agent commit, and refuse a red one (#3402).
 *
 * Pilot run 2026-10-03_180159 (l5-feature-e2e, main ed3ab9fd) scored 18/19: the agent
 * wrote test/cli.test.ts using Bun's `$` without importing it, ran `bun test`, got
 * "Exit code 1", staged, and committed anyway. Prompt wording had already told it to
 * test first. So the check lives in the tool: when the agent commits (git_commit, or
 * `git commit` through run_command) in a repo whose package.json has a test script,
 * the suite runs first through the same gated run_command the agent uses. A red suite
 * comes back as the tool result, with the failure, and nothing is committed.
 *
 * Rules, all deterministic:
 *   - No package.json test script (or npm's "no test specified" stub): commit as before.
 *   - Clean tree, or only docs changed (.md or .mdx files, LICENSE, NOTICE): commit as before.
 *   - Tree unchanged since a green run this session: commit without running again.
 *   - Red: refuse, return the first failing line and the end of the output. The same
 *     unchanged tree reuses that result without rerunning. After MAX_BLOCKS refusals on
 *     one unchanged tree the commit goes through, marked as committed red, so a suite
 *     that was already failing cannot trap the agent in a loop.
 *   - Red means any failing exit, including a suite killed by a signal (`Exit code null`)
 *     and an exit 126/127 with no "not found" or "cannot execute" line. Only output the
 *     gate recognises as a clean run is recorded green.
 *   - The suite does not finish in time, the runner cannot start (exit 126 or 127 with
 *     a "not found" or "cannot execute" line, such as no bun, yarn or pnpm on PATH), a
 *     gate stops it, or the commit targets another repository (`git -C`, `--work-tree`,
 *     `GIT_WORK_TREE=` resolving outside this one) or another git dir (`--git-dir`,
 *     `GIT_DIR=`): commit, and say it was not verified. `-C` naming this repository,
 *     by absolute path or a subdirectory, is gated as usual.
 *   - Green, but tracked files have unstaged changes: the suite saw the working tree, not
 *     what the commit holds, so the commit says it is not fully verified.
 *   - EIGHT_COMMIT_GATE=0 turns it off. EIGHT_COMMIT_GATE_TIMEOUT_SEC bounds one run
 *     (default 120, at most 300, run_command's own cap).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { firstFailure } from "../orchestration/verify-scope";
import { scrub } from "./secret-scanner";

/** Runs one command through the agent's own gated run_command and returns its output. */
export type GatedRun = (command: string, timeoutSec: number) => Promise<string>;

export type GateDecision = { commit: true; note?: string } | { commit: false; message: string };

export const MAX_BLOCKS = 2;
const TAIL_CHARS = 4000;

export function commitGateEnabled(): boolean {
	return process.env.EIGHT_COMMIT_GATE?.trim() !== "0";
}

export function commitGateTimeoutSec(): number {
	const n = Number(process.env.EIGHT_COMMIT_GATE_TIMEOUT_SEC?.trim());
	return Number.isFinite(n) && n > 0 ? Math.min(n, 300) : 120;
}

/** A commit found in a shell command: whether it commits every tracked change, and the directories it names. */
export type CommitTarget = {
	/** `-a` / `--all`: the commit takes the working tree's tracked changes, not only the index. */
	all: boolean;
	/**
	 * The `-C`, `--work-tree` and `GIT_WORK_TREE=` values in order, as written. The gate
	 * resolves them against its working directory, since the parser has none.
	 */
	dirs: string[];
	/** `--git-dir` or `GIT_DIR=` was given: the index lives somewhere else. */
	gitDir: boolean;
};

/** Split a shell command into simple commands of words, honouring quotes and backslashes. */
function shellSegments(command: string): string[][] {
	const segments: string[][] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: "'" | '"' | null = null;
	const endWord = () => {
		if (inWord) words.push(word);
		word = "";
		inWord = false;
	};
	const endSegment = () => {
		endWord();
		if (words.length) segments.push(words);
		words = [];
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote === "'") {
			if (c === "'") quote = null;
			else word += c;
		} else if (quote === '"') {
			if (c === '"') quote = null;
			else if (c === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1]))
				word += command[++i];
			else word += c;
		} else if (c === "'" || c === '"') {
			quote = c;
			inWord = true;
		} else if (c === "\\" && i + 1 < command.length) {
			if (command[i + 1] !== "\n") word += command[i + 1];
			i++;
			inWord = true;
		} else if (c === " " || c === "\t") endWord();
		else if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")")
			endSegment();
		else {
			word += c;
			inWord = true;
		}
	}
	endSegment();
	return segments;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(["env", "command", "exec", "nohup", "time", "builtin"]);
/** git's global options that take their value as the next word. */
const GIT_VALUE_OPTS = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--config-env",
	"--super-prefix",
	"--exec-path",
]);

/** `git commit` options that take a value; with a short option the value may be glued on. */
const COMMIT_VALUE_OPTS = new Set([
	"-m",
	"-F",
	"-C",
	"-c",
	"-t",
	"--message",
	"--file",
	"--reuse-message",
	"--reedit-message",
	"--template",
	"--author",
	"--date",
	"--fixup",
	"--squash",
	"--cleanup",
	"--trailer",
]);

/** Whether `git commit`'s own arguments include -a / --all, never reading an option's value. */
function commitsAll(rest: string[]): boolean {
	for (let i = 0; i < rest.length; i++) {
		const w = rest[i];
		if (w === "--") return false;
		if (w === "--all") return true;
		if (w.startsWith("--")) {
			if (!w.includes("=") && COMMIT_VALUE_OPTS.has(w)) i++;
			continue;
		}
		if (!/^-[A-Za-z]/.test(w)) continue;
		// A cluster such as -am: letters up to the first value-taking one, whose value is
		// the rest of the word or, when nothing is left, the next word.
		for (let j = 1; j < w.length; j++) {
			if (w[j] === "a") return true;
			if (COMMIT_VALUE_OPTS.has(`-${w[j]}`)) {
				if (j === w.length - 1) i++;
				break;
			}
		}
	}
	return false;
}

function commitInWords(words: string[]): CommitTarget | null {
	let i = 0;
	const dirs: string[] = [];
	let gitDir = false;
	// Leading NAME=value assignments and env/command-style wrappers (with env's own flags).
	for (;;) {
		const w = words[i];
		if (w === undefined) return null;
		if (ASSIGNMENT.test(w)) {
			if (w.startsWith("GIT_DIR=")) gitDir = true;
			if (w.startsWith("GIT_WORK_TREE=")) dirs.push(w.slice("GIT_WORK_TREE=".length));
			i++;
		} else if (WRAPPERS.has(w)) {
			i++;
			while (words[i]?.startsWith("-")) i += words[i] === "-u" ? 2 : 1;
		} else break;
	}
	// Case-insensitive: macOS runs `Git` or `GIT` as git.
	const exe = words[i++];
	if (exe === undefined || path.basename(exe).toLowerCase() !== "git") return null;
	for (; i < words.length; i++) {
		const w = words[i];
		if (!w.startsWith("-")) break;
		const eq = w.indexOf("=");
		const name = w.startsWith("--") && eq > 0 ? w.slice(0, eq) : w;
		const value = name !== w ? w.slice(eq + 1) : GIT_VALUE_OPTS.has(w) ? words[++i] : undefined;
		if (name === "-C" || name === "--work-tree") dirs.push(value ?? "");
		if (name === "--git-dir") gitDir = true;
	}
	if (words[i] !== "commit") return null;
	return { all: commitsAll(words.slice(i + 1)), dirs, gitDir };
}

/** The commit a shell command makes, or null when it makes none. */
export function parseGitCommit(command: string): CommitTarget | null {
	for (const words of shellSegments(command)) {
		const target = commitInWords(words);
		if (target) return target;
	}
	return null;
}

/** True for a shell command that makes a commit. */
export function isGitCommit(command: string): boolean {
	return parseGitCommit(command) !== null;
}

/** The command that runs this repo's test script, or null when it has none. */
export function detectTestCommand(cwd: string): string | null {
	const pkgPath = path.join(cwd, "package.json");
	if (!existsSync(pkgPath)) return null;
	let script: unknown;
	try {
		script = JSON.parse(readFileSync(pkgPath, "utf-8"))?.scripts?.test;
	} catch {
		return null;
	}
	if (typeof script !== "string" || !script.trim() || /no test specified/i.test(script))
		return null;
	const has = (f: string) => existsSync(path.join(cwd, f));
	if (has("bun.lock") || has("bun.lockb") || /^\s*bun\b/.test(script)) return "bun run test";
	if (has("pnpm-lock.yaml")) return "pnpm test";
	if (has("yarn.lock")) return "yarn test";
	return "npm test";
}

// Prose only. A .txt file can be a test fixture and docs/ can hold code, so neither counts.
const DOCS_ONLY = (p: string) =>
	/\.(md|mdx)$/i.test(p) || /^(LICENSE|NOTICE)(\.txt)?$/i.test(path.basename(p));

/** The real path of the repository that holds `dir`, or null when there is none. */
function toplevel(dir: string): string | null {
	if (!existsSync(dir)) return null;
	const r = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode !== 0) return null;
	try {
		return realpathSync(r.stdout.toString().trim());
	} catch {
		return null;
	}
}

/** Tracked files with changes that are not staged. */
function hasUnstaged(cwd: string): boolean {
	return Bun.spawnSync(["git", "diff", "--quiet"], { cwd }).exitCode === 1;
}

/**
 * A hash of every changed or untracked path (ignored files excluded) and its content on
 * disk. Staging does not change it, so "ran green, then git add" still matches.
 * null when this is not a git repo; "" when nothing changed or only docs changed.
 */
export function treeFingerprint(cwd: string): string | null {
	const r = Bun.spawnSync(["git", "status", "--porcelain=v1", "-z", "-uall"], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode !== 0) return null;
	const entries = r.stdout.toString().split("\0");
	const paths: string[] = [];
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		if (e.length < 4) continue;
		paths.push(e.slice(3));
		// A rename or copy carries its source path as the next entry.
		if (e[0] === "R" || e[0] === "C") paths.push(entries[++i] ?? "");
	}
	const changed = paths.filter(Boolean).sort();
	if (changed.length === 0 || changed.every(DOCS_ONLY)) return "";
	const h = createHash("sha256");
	for (const p of changed) {
		h.update(`${p}\0`);
		const abs = path.join(cwd, p);
		try {
			h.update(statSync(abs).isFile() ? readFileSync(abs) : "<not a file>");
		} catch {
			h.update("<absent>");
		}
		h.update("\0");
	}
	return h.digest("hex");
}

type Last = { tree: string; result: "green" | "red"; message?: string; blocks: number };

/** One per ToolExecutor, so "since the last green run" means this agent's session. */
export class CommitGate {
	private last: Last | undefined;

	constructor(
		private readonly cwd: string,
		private readonly run: GatedRun,
	) {}

	/** `target` is the commit a run_command makes; git_commit passes none. */
	async check(target?: CommitTarget): Promise<GateDecision> {
		if (!commitGateEnabled()) return { commit: true };
		const elsewhere = target && this.elsewhere(target);
		if (elsewhere) {
			const where = elsewhere === "git-dir" ? "another git dir" : `\`${elsewhere}\``;
			return {
				commit: true,
				note: `[COMMIT GATE] This commit targets ${where}, not the repository in the working directory, so the test suite was not run for it and the commit is not verified.`,
			};
		}
		const testCommand = detectTestCommand(this.cwd);
		if (!testCommand) return { commit: true };
		const tree = treeFingerprint(this.cwd);
		if (!tree) return { commit: true };

		const last = this.last?.tree === tree ? this.last : undefined;
		if (last?.result === "green") return this.green(target);
		if (last?.result === "red") {
			if (last.blocks >= MAX_BLOCKS) {
				return {
					commit: true,
					note: `[COMMIT GATE] Committed with \`${testCommand}\` still failing: the commit was refused ${MAX_BLOCKS} times on these exact changes. Say so in your summary; do not report the suite as green.`,
				};
			}
			last.blocks++;
			return { commit: false, message: last.message as string };
		}

		const timeoutSec = commitGateTimeoutSec();
		const output = await this.run(testCommand, timeoutSec);
		const text = output.trimStart();
		const unverified = (why: string): GateDecision => ({
			commit: true,
			note: `[COMMIT GATE] \`${testCommand}\` ${why}, so this commit is not verified by the test suite.`,
		});

		// `Exit code null` is a suite killed by a signal: a crash, so red.
		const exit = /^Exit code (-?\d+|null):\n?/.exec(text);
		if (exit) {
			// Scrub before any cut, so no secret survives as a fragment the scanner misses.
			const body = scrub(text.slice(exit[0].length)).scrubbed;
			// 126/127 with the shell saying so: the runner, or a binary the script calls,
			// could not start. No test ran. Without that line it is an ordinary failure.
			const cannotStart = body
				.split("\n")
				.map((l) => l.trim())
				.find((l) => /not found|cannot execute/i.test(l));
			if ((exit[1] === "126" || exit[1] === "127") && cannotStart)
				return unverified(`could not run (${cannotStart.slice(0, 200)})`);
			const tail = body.length > TAIL_CHARS ? `...\n${body.slice(-TAIL_CHARS)}` : body;
			const how = exit[1] === "null" ? "was killed before it finished" : "fails";
			const message = [
				`[COMMIT BLOCKED] Not committed: \`${testCommand}\` ${how}. Fix the failing tests, run \`${testCommand}\` until it passes, then commit again.`,
				`First failure: ${firstFailure(body)}`,
				"",
				tail.trimEnd(),
			].join("\n");
			this.last = { tree, result: "red", message, blocks: 1 };
			return { commit: false, message };
		}
		if (text.startsWith("TIMEOUT after")) return unverified(`did not finish in ${timeoutSec}s`);
		// A gate marker, an error, or nothing at all: the gate cannot call it a clean run.
		if (!text || text.startsWith("[") || text.startsWith("Error")) {
			const first = scrub(text.split("\n")[0] || "no output").scrubbed.slice(0, 200);
			return unverified(`could not run (${first})`);
		}
		this.last = { tree, result: "green", blocks: 0 };
		return this.green(target);
	}

	/**
	 * Null when the commit lands in the working directory's own repository (`-C` the
	 * absolute cwd, `-C sub`, `-C ./` all do), so the gate runs as usual. Otherwise the
	 * absolute directory it targets, or "git-dir" for --git-dir / GIT_DIR=.
	 */
	private elsewhere(target: CommitTarget): string | null {
		if (target.gitDir) return "git-dir";
		if (target.dirs.length === 0) return null;
		const dir = target.dirs.reduce((cur, d) => path.resolve(cur, d), this.cwd);
		const here = toplevel(this.cwd);
		return here !== null && toplevel(dir) === here ? null : dir;
	}

	private green(target?: CommitTarget): GateDecision {
		if (target?.all || !hasUnstaged(this.cwd)) return { commit: true };
		return {
			commit: true,
			note: "[COMMIT GATE] The suite passed on the working tree, but some changes are not staged, so what this commit holds is not verified. Stage everything you mean to commit, or say so in your summary.",
		};
	}
}
