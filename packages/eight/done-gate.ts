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
 * So the harness runs the project's check itself, through the agent's own gated
 * run_command, once before the agent starts (the baseline) and again after it answers
 * when the run changed files:
 *   - Cargo.toml: `cargo test` (compiles the crate and its tests, then runs them)
 *   - package.json test script: the commit gate's detected command
 *   - go.mod: `go test ./...`
 * Only a result worse than the baseline counts: green before and red now, or failures
 * the baseline did not have. That goes back to the model as a new message and the check
 * runs again, up to EIGHT_DONE_GATE_ATTEMPTS fix rounds (default 2); still worse ends the
 * run as a failure. Red before and no new failures is reported as pre-existing and the
 * run succeeds, so a docs edit in an already-red repo is not sent off to "fix" tests.
 * Pre-existing needs failures recognised on both sides (cargo, rustc, bun, go, tsc);
 * red to red on any other runner is reported as unverified, exit 0.
 * A check (before or after) that times out or cannot start makes the result unverified,
 * never green. Checks run with a scrubbed environment (no credential variables) and only
 * when the run has --yes, until run_command has an OS sandbox (#3612).
 * EIGHT_DONE_GATE=0 turns it off; EIGHT_DONE_GATE_TIMEOUT_SEC bounds each
 * check run (default and ceiling 300).
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { firstFailure } from "../orchestration/verify-scope";
import { detectTestCommand } from "./commit-gate";
import { scrub } from "./secret-scanner";

export const DONE_GATE_TAG = "[DONE GATE]";
const TAIL_CHARS = 4000;
const MAX_FILES = 20_000;
const SKIP_DIRS = new Set([".git", ".8gent", "node_modules", "target", "dist", "build", ".next"]);

type Env = Record<string, string | undefined>;

/** Runs one check command through the agent's gated run_command, with this environment. */
export type GateRun = (command: string, timeoutSec: number, env: Env) => Promise<string>;

// A name segment that marks a credential: OPENROUTER_API_KEY, GH_TOKEN, CLIENT_SECRET,
// DB_PASSWORD, AWS_ACCESS_KEY_ID, GOOGLE_APPLICATION_CREDENTIALS, ...
const SECRET_NAME =
	/(^|_)(KEY|KEYS|APIKEY|TOKEN|TOKENS|SECRET|SECRETS|PASSWORD|PASSWD|PASS|CREDENTIAL|CREDENTIALS|PAT|AUTH)(_|$)/i;

/**
 * The environment a gate check runs with: the parent's, minus every variable whose
 * name marks a credential or whose value the secret scanner recognises as one. The
 * check runs repo code (build scripts, test scripts) the model never chose, so provider
 * keys and tokens must not reach it. PATH, HOME and the toolchain variables (CARGO_*,
 * RUSTUP_*, GO*, npm_config_*) stay.
 */
export function scrubbedEnv(env: Env): Env {
	const out: Env = {};
	for (const [k, v] of Object.entries(env)) {
		if (SECRET_NAME.test(k)) continue;
		if (v && scrub(v).scrubbed !== v) continue;
		out[k] = v;
	}
	return out;
}

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
			let st: ReturnType<typeof lstatSync>;
			try {
				// lstat: a symlink is hashed as itself, never followed out of the project.
				st = lstatSync(abs);
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

/**
 * What identifies each failure in a check's output, as a count per signature. Line
 * numbers are dropped (they move with every edit); the file is kept when the next
 * line names it. Compared baseline vs after to tell "got worse" from "was already red".
 */
export function failureSignatures(output: string): Map<string, number> {
	const lines = output.split("\n").map((l) => l.trim());
	const sigs = new Map<string, number>();
	const add = (k: string) => sigs.set(k, (sigs.get(k) ?? 0) + 1);
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		const rustc = /^error(\[E\d+\]: .*)$/.exec(l);
		const cargoTest = /^test (\S+) \.\.\. FAILED$/.exec(l);
		const bun = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(l);
		const go = /^--- FAIL: (\S+)/.exec(l);
		const tsc = /^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/.exec(l);
		if (rustc) {
			const at = /^--> (.+?):\d+/.exec(lines[i + 1] ?? "");
			add(`rustc ${rustc[1]}${at ? ` @ ${at[1]}` : ""}`);
		} else if (cargoTest) add(`cargo test ${cargoTest[1]}`);
		else if (bun) add(`bun ${bun[1]}`);
		else if (go) add(`go ${go[1]}`);
		else if (tsc) add(`tsc ${tsc[1]} ${tsc[2]}: ${tsc[3]}`);
	}
	return sigs;
}

/** Signatures whose count went up from `before` to `after`. */
export function newFailures(before: Map<string, number>, after: Map<string, number>): string[] {
	return [...after].filter(([k, n]) => n > (before.get(k) ?? 0)).map(([k]) => k);
}

export function fixMessage(
	command: string,
	red: { firstFailure: string; tail: string },
	introduced: readonly string[] = [],
): string {
	return [
		`${DONE_GATE_TAG} You are not done: \`${command}\` fails in this project.`,
		...(introduced.length
			? [
					`It was already failing before you started, but these failures are new: ${introduced.slice(0, 10).join("; ")}`,
				]
			: []),
		"Fix the code so it builds and the tests pass, run the command yourself to confirm,",
		'then reply with your final summary starting with "DONE:".',
		`First failure: ${red.firstFailure}`,
		"",
		red.tail,
	].join("\n");
}

export type CheckOutcome = { read: CheckRead; signatures: Map<string, number> };

/** The project check before the agent runs: what "not worse" is measured against. */
export type Baseline =
	| { command: string; outcome: CheckOutcome }
	| { command: string; skipped: string }
	| { command: null };

async function runCheck(
	run: GateRun,
	command: string,
	timeoutSec: number,
	env: Env,
): Promise<CheckOutcome> {
	const output = await run(command, timeoutSec, scrubbedEnv(env));
	const read = readCheck(output, timeoutSec);
	// Signatures reach the model (fixMessage), so they come from scrubbed output.
	const signatures = read.kind === "fail" ? failureSignatures(scrub(output).scrubbed) : new Map();
	return { read, signatures };
}

export const NEEDS_YES = "done gate skipped (needs --yes)";

/**
 * Run the project check once before the agent starts. Costs one check run, bounded by
 * the same EIGHT_DONE_GATE_TIMEOUT_SEC cap. No check when the gate is off or no command
 * is known. Without consent (the run had no --yes) nothing runs: the check executes repo
 * code, so until run_command has an OS sandbox it needs the same consent as an
 * autonomous shell.
 */
export async function baselineCheck(opts: {
	cwd: string;
	run: GateRun;
	consent: boolean;
	env?: Env;
}): Promise<Baseline> {
	const env = opts.env ?? process.env;
	if (!doneGateEnabled(env)) return { command: null };
	const command = detectProjectCheck(opts.cwd);
	if (!command) return { command: null };
	if (!opts.consent) return { command, skipped: NEEDS_YES };
	return { command, outcome: await runCheck(opts.run, command, doneGateTimeoutSec(env), env) };
}

export type DoneVerdict = {
	/**
	 * pass: green after the run. fail: worse than before and not fixed in budget.
	 * pre-existing: red, but no failure the baseline did not already have.
	 * unverified: a check (baseline or after) timed out or could not run.
	 * skipped: gate off, no known check, or the run changed nothing.
	 */
	status: "pass" | "fail" | "pre-existing" | "unverified" | "skipped";
	command?: string;
	/** Fix rounds sent to the model. */
	fixRounds: number;
	detail?: string;
	finalText: string;
};

/**
 * Run the project's check after the agent answered and compare with the baseline. Only a
 * result worse than the baseline (green before and red now, or new failures) goes back
 * to the model through `chat`, within the attempt budget.
 */
export async function finishWithProjectCheck(opts: {
	baseline: Baseline;
	changed: boolean;
	finalText: string;
	run: GateRun;
	chat: (message: string) => Promise<string>;
	env?: Env;
}): Promise<DoneVerdict> {
	const env = opts.env ?? process.env;
	let finalText = opts.finalText;
	const { baseline } = opts;
	if (baseline.command === null || !opts.changed)
		return { status: "skipped", fixRounds: 0, finalText };
	if ("skipped" in baseline)
		return {
			status: "skipped",
			command: baseline.command,
			fixRounds: 0,
			detail: baseline.skipped,
			finalText,
		};
	const { command } = baseline;
	const before = baseline.outcome.read;
	if (before.kind === "unverified")
		return {
			status: "unverified",
			command,
			fixRounds: 0,
			detail: `\`${command}\` ${before.reason} before the run, so the result cannot be compared`,
			finalText,
		};
	const attempts = doneGateAttempts(env);
	const timeoutSec = doneGateTimeoutSec(env);
	for (let round = 0; ; round++) {
		const { read, signatures } = await runCheck(opts.run, command, timeoutSec, env);
		if (read.kind === "pass") return { status: "pass", command, fixRounds: round, finalText };
		if (read.kind === "unverified")
			return {
				status: "unverified",
				command,
				fixRounds: round,
				detail: `\`${command}\` ${read.reason}`,
				finalText,
			};
		let added: string[] = [];
		if (before.kind === "fail") {
			// Comparing needs failures recognised on both sides. Output from a runner the
			// gate cannot parse (jest, vitest, mocha, free text) proves nothing either way.
			if (baseline.outcome.signatures.size === 0 || signatures.size === 0)
				return {
					status: "unverified",
					command,
					fixRounds: round,
					detail: `\`${command}\` was already failing before this run; could not tell whether this run added failures`,
					finalText,
				};
			added = newFailures(baseline.outcome.signatures, signatures);
			// Both sides parsed and every failure now was there before: not this run's doing.
			if (added.length === 0)
				return {
					status: "pre-existing",
					command,
					fixRounds: round,
					detail: `\`${command}\` was already failing before this run (${before.firstFailure}); pre-existing failures, not caused by this run`,
					finalText,
				};
		}
		if (round >= attempts)
			return {
				status: "fail",
				command,
				fixRounds: round,
				detail: `\`${command}\` still fails: ${read.firstFailure}`,
				finalText,
			};
		finalText = await opts.chat(fixMessage(command, read, added));
	}
}

/** The line a reader sees under the final answer, or null when there is nothing to say. */
export function verdictNotice(v: DoneVerdict): string | null {
	switch (v.status) {
		case "fail":
			return `${DONE_GATE_TAG} FAILED: ${v.detail}. This run did not leave the project building and passing.`;
		case "unverified":
			return `${DONE_GATE_TAG} NOT VERIFIED: ${v.detail}. The project's build and tests were not confirmed.`;
		case "pre-existing":
			return `${DONE_GATE_TAG} ${v.detail}.`;
		case "skipped":
			return v.detail ? `${DONE_GATE_TAG} ${v.detail}: \`${v.command}\` was not run.` : null;
		default:
			return null;
	}
}
