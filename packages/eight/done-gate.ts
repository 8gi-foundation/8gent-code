/**
 * Done gate: a headless `8gent run` cannot report success while the project's own
 * build or test fails.
 *
 * SIGI baseline 2026-10 (Rust exercises, local 27B): the 8gent-code arm finished two
 * tasks with code that did not compile and still emitted `result/ok`. Nothing on the
 * `run --yes` path ran the project's build: the verify gate (#3550) is off by default
 * and counts a read_file as a check, and the commit gate (#3402) only fires on a
 * commit and only knows package.json test scripts, so a Cargo crate had no check at all.
 *
 * So after the agent answers, when the run changed files in the working directory, the
 * harness runs the project's check itself, through the agent's own gated run_command:
 *   - Cargo.toml: `cargo test` (compiles the crate and its tests, then runs them)
 *   - package.json test script: the commit gate's detected command
 *   - go.mod: `go test ./...`
 * Red: the failure goes back to the model as a new message and the check runs again,
 * up to EIGHT_DONE_GATE_ATTEMPTS fix rounds (default 2). Still red: the run ends as a
 * failure. A check that times out or cannot start is reported as unverified, never green.
 * EIGHT_DONE_GATE=0 turns it off.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { firstFailure } from "../orchestration/verify-scope";
import { type GatedRun, detectTestCommand } from "./commit-gate";
import { scrub } from "./secret-scanner";

export const DONE_GATE_TAG = "[DONE GATE]";
const TAIL_CHARS = 4000;
const MAX_FILES = 20_000;
const SKIP_DIRS = new Set([".git", ".8gent", "node_modules", "target", "dist", "build", ".next"]);

type Env = Record<string, string | undefined>;

export function doneGateEnabled(env: Env = process.env): boolean {
	return env.EIGHT_DONE_GATE?.trim() !== "0";
}

/** Fix rounds after the first red check. Default 2, 0 to 5. */
export function doneGateAttempts(env: Env = process.env): number {
	const n = Number(env.EIGHT_DONE_GATE_ATTEMPTS?.trim());
	return env.EIGHT_DONE_GATE_ATTEMPTS?.trim() && Number.isInteger(n) && n >= 0 ? Math.min(n, 5) : 2;
}

/** Bound on one check run, seconds. Default and ceiling 300, run_command's own cap. */
export function doneGateTimeoutSec(env: Env = process.env): number {
	const n = Number(env.EIGHT_DONE_GATE_TIMEOUT_SEC?.trim());
	return Number.isFinite(n) && n > 0 ? Math.min(n, 300) : 300;
}

/** The command that builds and tests this project, or null when none is known. */
export function detectProjectCheck(cwd: string): string | null {
	if (existsSync(path.join(cwd, "Cargo.toml"))) return "cargo test";
	const test = detectTestCommand(cwd);
	if (test) return test;
	if (existsSync(path.join(cwd, "go.mod"))) return "go test ./...";
	return null;
}

/**
 * Path, size and mtime of every file under cwd, hashed; build output and VCS dirs
 * skipped. Compared before and after a run to tell whether the run changed anything.
 * Past MAX_FILES it returns a unique value, so a huge tree always counts as changed.
 */
export function projectFingerprint(cwd: string): string {
	const h = createHash("sha256");
	let files = 0;
	const walk = (dir: string): boolean => {
		let names: string[];
		try {
			names = readdirSync(dir).sort();
		} catch {
			return true;
		}
		for (const name of names) {
			const abs = path.join(dir, name);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(abs);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				if (SKIP_DIRS.has(name)) continue;
				if (!walk(abs)) return false;
			} else {
				if (++files > MAX_FILES) return false;
				h.update(`${path.relative(cwd, abs)}\0${st.size}\0${st.mtimeMs}\0`);
			}
		}
		return true;
	};
	return walk(cwd) ? h.digest("hex") : `over-limit-${Date.now()}-${Math.random()}`;
}

export type CheckRead =
	| { kind: "pass" }
	| { kind: "fail"; firstFailure: string; tail: string }
	| { kind: "unverified"; reason: string };

/** Read run_command's output the way the commit gate does: only a clean exit is green. */
export function readCheck(output: string, timeoutSec: number): CheckRead {
	const text = output.trimStart();
	const exit = /^Exit code (-?\d+|null):\n?/.exec(text);
	if (exit) {
		const body = scrub(text.slice(exit[0].length)).scrubbed;
		const cannotStart = body
			.split("\n")
			.map((l) => l.trim())
			.find((l) => /not found|cannot execute/i.test(l));
		if ((exit[1] === "126" || exit[1] === "127") && cannotStart)
			return { kind: "unverified", reason: `could not run (${cannotStart.slice(0, 200)})` };
		const tail = body.length > TAIL_CHARS ? `...\n${body.slice(-TAIL_CHARS)}` : body;
		// rustc's own diagnostic ("error[E0308]: mismatched types") names the cause;
		// cargo's closing "error: could not compile" does not, so prefer it.
		const rustc = body
			.split("\n")
			.map((l) => l.trim())
			.find((l) => /^error\[E\d+\]:/.test(l));
		const first = rustc ? rustc.slice(0, 200) : firstFailure(body);
		return { kind: "fail", firstFailure: first, tail: tail.trimEnd() };
	}
	if (text.startsWith("TIMEOUT after"))
		return { kind: "unverified", reason: `did not finish in ${timeoutSec}s` };
	if (!text || text.startsWith("[") || text.startsWith("Error")) {
		const first = scrub(text.split("\n")[0] || "no output").scrubbed.slice(0, 200);
		return { kind: "unverified", reason: `could not run (${first})` };
	}
	return { kind: "pass" };
}

export function fixMessage(command: string, red: { firstFailure: string; tail: string }): string {
	return [
		`${DONE_GATE_TAG} You are not done: \`${command}\` fails in this project.`,
		"Fix the code so it builds and the tests pass, run the command yourself to confirm,",
		'then reply with your final summary starting with "DONE:".',
		`First failure: ${red.firstFailure}`,
		"",
		red.tail,
	].join("\n");
}

export type DoneVerdict = {
	status: "pass" | "fail" | "unverified" | "skipped";
	command?: string;
	/** Fix rounds sent to the model. */
	fixRounds: number;
	detail?: string;
	finalText: string;
};

/**
 * Run the project's check after the agent answered; feed a red result back through
 * `chat` and check again, within the attempt budget.
 */
export async function finishWithProjectCheck(opts: {
	cwd: string;
	changed: boolean;
	finalText: string;
	run: GatedRun;
	chat: (message: string) => Promise<string>;
	env?: Env;
}): Promise<DoneVerdict> {
	const env = opts.env ?? process.env;
	let finalText = opts.finalText;
	if (!doneGateEnabled(env) || !opts.changed) return { status: "skipped", fixRounds: 0, finalText };
	const command = detectProjectCheck(opts.cwd);
	if (!command) return { status: "skipped", fixRounds: 0, finalText };
	const attempts = doneGateAttempts(env);
	const timeoutSec = doneGateTimeoutSec(env);
	for (let round = 0; ; round++) {
		const read = readCheck(await opts.run(command, timeoutSec), timeoutSec);
		if (read.kind === "pass") return { status: "pass", command, fixRounds: round, finalText };
		if (read.kind === "unverified")
			return { status: "unverified", command, fixRounds: round, detail: read.reason, finalText };
		if (round >= attempts)
			return {
				status: "fail",
				command,
				fixRounds: round,
				detail: `\`${command}\` still fails: ${read.firstFailure}`,
				finalText,
			};
		finalText = await opts.chat(fixMessage(command, read));
	}
}
