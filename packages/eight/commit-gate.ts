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
 *   - Clean tree, or only docs changed (.md, .mdx, .txt, docs/): commit as before.
 *   - Tree unchanged since a green run this session: commit without running again.
 *   - Red: refuse, return the first failing line and the end of the output. The same
 *     unchanged tree reuses that result without rerunning. After MAX_BLOCKS refusals on
 *     one unchanged tree the commit goes through, marked as committed red, so a suite
 *     that was already failing cannot trap the agent in a loop.
 *   - The suite does not finish in time, or a gate stops it: commit, and say the suite
 *     was not verified. The gate never blocks on something it could not measure.
 *   - EIGHT_COMMIT_GATE=0 turns it off. EIGHT_COMMIT_GATE_TIMEOUT_SEC bounds one run
 *     (default 120, at most 300, run_command's own cap).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { firstFailure } from "../orchestration/verify-scope";

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

/** True for a shell command that makes a commit: `git commit ...`, `git -c k=v commit ...`. */
export function isGitCommit(command: string): boolean {
	return /^\s*git(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*\s+commit(?:\s|$)/.test(command);
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

const DOCS_ONLY = (p: string) => /\.(md|mdx|txt)$/i.test(p) || p.startsWith("docs/");

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

	async check(): Promise<GateDecision> {
		if (!commitGateEnabled()) return { commit: true };
		const testCommand = detectTestCommand(this.cwd);
		if (!testCommand) return { commit: true };
		const tree = treeFingerprint(this.cwd);
		if (!tree) return { commit: true };

		const last = this.last?.tree === tree ? this.last : undefined;
		if (last?.result === "green") return { commit: true };
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

		if (/^Exit code -?\d+:/.test(text)) {
			const body = text.replace(/^Exit code -?\d+:\n?/, "");
			const tail = body.length > TAIL_CHARS ? `...\n${body.slice(-TAIL_CHARS)}` : body;
			const message = [
				`[COMMIT BLOCKED] Not committed: \`${testCommand}\` fails. Fix the failing tests, run \`${testCommand}\` until it passes, then commit again.`,
				`First failure: ${firstFailure(body)}`,
				"",
				tail.trimEnd(),
			].join("\n");
			this.last = { tree, result: "red", message, blocks: 1 };
			return { commit: false, message };
		}
		if (text.startsWith("TIMEOUT after")) {
			return {
				commit: true,
				note: `[COMMIT GATE] \`${testCommand}\` did not finish in ${timeoutSec}s, so this commit is not verified by the test suite.`,
			};
		}
		if (/^\[[A-Z0-9 -]*(BLOCKED|DENIED)[A-Z0-9 -]*\]/.test(text) || text.startsWith("Error:")) {
			const first = text.split("\n")[0].slice(0, 200);
			return {
				commit: true,
				note: `[COMMIT GATE] \`${testCommand}\` could not run (${first}), so this commit is not verified by the test suite.`,
			};
		}
		this.last = { tree, result: "green", blocks: 0 };
		return { commit: true };
	}
}
