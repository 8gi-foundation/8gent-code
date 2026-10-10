/**
 * Whether a sub-agent FIXED the files in its scope, not only whether it wrote
 * to them.
 *
 * Pilot run 2026-09-30_083409 (l4-spawn-parallel-m5): a llama3.2:3b sub-agent
 * rewrote src/wordcount.ts with the same bug. The write succeeded, so
 * check_agent said "changed src/wordcount.ts", and the Orchestrator reported
 * both files fixed while the visible and hidden tests failed.
 *
 * So the pool hashes every file in an agent's scope when it spawns, and when
 * the agent ends it compares hashes and, for a changed file with a sibling
 * test (`<name>.test.ts`), runs that test through the same gated run_command
 * a sub-agent uses: bounded by a timeout, inside the working directory. The
 * verdict is evidence or it is "not verified"; nothing here ever says fixed
 * without a passing test, and a gate that says no is reported, not bypassed.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

export type FileVerdict =
	| { file: string; state: "unchanged" }
	| { file: string; state: "fixed"; test: string }
	| { file: string; state: "test-fails"; test: string; firstFailure: string }
	| { file: string; state: "test-timeout"; test: string; timeoutMs: number }
	| { file: string; state: "blocked"; test: string; reason: string }
	| { file: string; state: "unverified" };

/** File path (relative to the working directory) -> sha256 of its content, or null when absent. */
export type ScopeBaseline = Record<string, string | null>;

const hashOf = (abs: string): string | null =>
	existsSync(abs) && statSync(abs).isFile()
		? createHash("sha256").update(readFileSync(abs)).digest("hex")
		: null;

const inside = (wd: string, abs: string) => abs === wd || abs.startsWith(`${wd}${path.sep}`);

/**
 * Hash each file an agent may edit, at spawn. Directory entries and paths
 * outside the working directory are left out: there is no single file to
 * verify, so those agents keep the write-based outcome.
 */
export function snapshotScope(
	workingDirectory: string,
	allowedPaths: readonly string[] | undefined,
): ScopeBaseline {
	const wd = path.resolve(workingDirectory);
	const out: ScopeBaseline = {};
	for (const p of allowedPaths ?? []) {
		const abs = path.resolve(wd, p);
		if (!inside(wd, abs) || (existsSync(abs) && statSync(abs).isDirectory())) continue;
		out[path.relative(wd, abs).split(path.sep).join("/")] = hashOf(abs);
	}
	return out;
}

/** `src/x.ts` -> `src/x.test.ts` (same for .tsx, .js, .jsx); null for anything else or a test itself. */
export function siblingTest(file: string): string | null {
	const m = /^(.*?)(\.test)?(\.[jt]sx?)$/.exec(file);
	if (!m || m[2]) return null;
	return `${m[1]}.test${m[3]}`;
}

/** The first line of a bun test run that says what failed. */
export function firstFailure(output: string): string {
	const lines = output.split("\n").map((l) => l.trim());
	const line =
		lines.find((l) => l.startsWith("(fail)")) ??
		lines.find((l) => /^error:/i.test(l)) ??
		lines.find((l) => /\b\d+ fail\b/.test(l)) ??
		lines.find((l) => l !== "") ??
		"no output";
	return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/** Bound on one sibling test run (ms). EIGHT_VERIFY_TEST_TIMEOUT_MS overrides. */
export function verifyTestTimeoutMs(): number {
	const raw = process.env.EIGHT_VERIFY_TEST_TIMEOUT_MS?.trim();
	const ms = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(ms) && ms > 0 ? ms : 60_000;
}

/**
 * Runs one command the way the agent's own run_command does, gates included,
 * and returns run_command's output. The pool passes a ToolExecutor's
 * execute("run_command"), so a verify run goes through the same maker-checker,
 * ToolG8 policy, permission manager, shell sanitizer and System One gates as
 * any command a sub-agent asks for (#3126 review). This module never spawns a
 * process itself.
 */
export type GatedRunner = (command: string, timeoutMs: number) => Promise<string>;

/**
 * Read run_command's output. It returns the command's stdout unchanged only on
 * exit 0, "Exit code N:" on a failure, "TIMEOUT after" on a timeout, and a
 * marker ([PERMISSION DENIED], [BLOCKED], [SYSTEM ONE BLOCKED], ...) when a gate
 * stopped it. FIXED needs positive evidence: bun test's own header on a clean
 * exit. Anything unrecognised is treated as blocked, never as a pass.
 */
export function classifyRun(
	output: string,
):
	| { kind: "pass" }
	| { kind: "fail"; firstFailure: string }
	| { kind: "timeout" }
	| { kind: "blocked"; reason: string } {
	const text = output.trimStart();
	if (/^Exit code -?\d+:/.test(text))
		return { kind: "fail", firstFailure: firstFailure(text.replace(/^Exit code -?\d+:/, "")) };
	if (text.startsWith("TIMEOUT after")) return { kind: "timeout" };
	if (/^bun test v\d/.test(text)) return { kind: "pass" };
	const first =
		text
			.split("\n")
			.find((l) => l.trim() !== "")
			?.trim() ?? "no output";
	return { kind: "blocked", reason: first.length > 200 ? `${first.slice(0, 197)}...` : first };
}

// A test path safe to put on a command line: no quoting, no shell syntax.
const SAFE_PATH = /^[\w./-]+$/;

/**
 * Compare against the spawn-time hashes and run each changed file's sibling
 * test through `run` (the gated run_command). Only a clean, recognised bun test
 * run yields "fixed".
 */
export async function verifyScope(
	workingDirectory: string,
	baseline: ScopeBaseline,
	run: GatedRunner,
	timeoutMs = verifyTestTimeoutMs(),
): Promise<FileVerdict[]> {
	const wd = path.resolve(workingDirectory);
	const verdicts: FileVerdict[] = [];
	for (const [file, before] of Object.entries(baseline)) {
		if (hashOf(path.resolve(wd, file)) === before) {
			verdicts.push({ file, state: "unchanged" });
			continue;
		}
		const test = siblingTest(file);
		const testAbs = test ? path.resolve(wd, test) : "";
		if (!test || !SAFE_PATH.test(test) || !inside(wd, testAbs) || !existsSync(testAbs)) {
			verdicts.push({ file, state: "unverified" });
			continue;
		}
		try {
			const r = classifyRun(await run(`bun test ./${test}`, timeoutMs));
			if (r.kind === "pass") verdicts.push({ file, state: "fixed", test });
			else if (r.kind === "fail")
				verdicts.push({ file, state: "test-fails", test, firstFailure: r.firstFailure });
			else if (r.kind === "timeout")
				verdicts.push({ file, state: "test-timeout", test, timeoutMs });
			else verdicts.push({ file, state: "blocked", test, reason: r.reason });
		} catch (err) {
			verdicts.push({
				file,
				state: "blocked",
				test,
				reason: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return verdicts;
}
