/**
 * Finding: the benchmark grader handed the whole parent environment to
 * model-written code. execution-grader.ts ran `bun test` on LLM output with
 * `env: { ...process.env, ... }`, so every provider key, forge token and 2FA
 * seed was readable from code the model wrote, executed unsandboxed.
 * Measured by Artale through the real gradeExecution(): 20 secret-shaped
 * variables visible before, 0 after.
 *
 * Fix: PR 2989 (commit 21284adc, childEnv() allow-list).
 * credit: Artale (8SO)
 *
 * This drives the REAL gradeExecution() and gradeMultiFileExecution(), not a
 * hand-rolled spawn. The "model output" is code that writes its own
 * environment to a report file; the test then reads what the child could see.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gradeExecution, gradeMultiFileExecution } from "../../benchmarks/autoresearch/execution-grader";
import type { BenchmarkDefinition } from "../../benchmarks/types";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CANARY_NAME = "EIGHT_SEC_CANARY";
const CANARY_VALUE = `canary-${randomBytes(12).toString("hex")}`;
// Secret-shaped names planted in the parent. None may reach the child.
const PLANTED = {
	EIGHT_SEC_FAKE_API_KEY: `k-${randomBytes(8).toString("hex")}`,
	EIGHT_SEC_FAKE_TOKEN: `t-${randomBytes(8).toString("hex")}`,
	EIGHT_SEC_FAKE_SECRET: `s-${randomBytes(8).toString("hex")}`,
	EIGHT_SEC_FAKE_PASSWORD: `p-${randomBytes(8).toString("hex")}`,
};
const SECRET_SHAPED = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|SEED|PRIVATE/i;

let reportDir = "";

/** The code the "model" wrote: dump the environment it can see. */
function probeCode(reportPath: string): string {
	return [
		`import { writeFileSync } from "node:fs";`,
		`writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(process.env));`,
		`export const ok = true;`,
	].join("\n");
}

function bench(id: string): BenchmarkDefinition {
	return {
		id,
		category: "bug-fixing",
		title: "security probe",
		difficulty: "easy",
		prompt: "",
		keywords: [],
		keywordThreshold: 0,
		testExecution: true,
		// testFile is joined onto benchmarks/, so step out to the repo root.
		testFile: "../tests/security/fixtures/grader-env-probe.ts",
		timeoutMs: 30_000,
	};
}

function readReport(path: string): Record<string, string> {
	return JSON.parse(readFileSync(path, "utf-8"));
}

beforeAll(() => {
	reportDir = mkdtempSync(join(tmpdir(), "eight-sec-grader-"));
	process.env[CANARY_NAME] = CANARY_VALUE;
	for (const [k, v] of Object.entries(PLANTED)) process.env[k] = v;
});

afterAll(() => {
	delete process.env[CANARY_NAME];
	for (const k of Object.keys(PLANTED)) delete process.env[k];
	rmSync(reportDir, { recursive: true, force: true });
});

describe("grader environment isolation (PR 2989)", () => {
	for (const mode of ["single-file", "multi-file"] as const) {
		test(`${mode}: model-written code cannot see the parent's canary or secret-shaped vars`, async () => {
			const reportPath = join(reportDir, `${mode}.json`);
			const result =
				mode === "single-file"
					? await gradeExecution(probeCode(reportPath), bench(`sec-env-${mode}`))
					: await gradeMultiFileExecution(
							[{ path: "probe.ts", content: probeCode(reportPath) }],
							bench(`sec-env-${mode}`),
						);

			// Precondition: the probe really ran inside the grader's child.
			// Without this, a broken harness would make the test pass vacuously.
			expect(result.passedTests).toBe(1);
			const childEnv = readReport(reportPath);
			expect(Object.keys(childEnv).length).toBeGreaterThan(0);

			// The random canary must not cross.
			expect(childEnv[CANARY_NAME]).toBeUndefined();
			expect(JSON.stringify(childEnv)).not.toContain(CANARY_VALUE);

			// Nothing secret-shaped may cross, planted or pre-existing.
			for (const [k, v] of Object.entries(PLANTED)) {
				expect(childEnv[k]).toBeUndefined();
				expect(JSON.stringify(childEnv)).not.toContain(v);
			}
			const leaked = Object.keys(childEnv).filter((k) => SECRET_SHAPED.test(k));
			expect(leaked).toEqual([]);
		}, 60_000);
	}
});

// ── Static pin ────────────────────────────────────────────────────────

/** Strip // and block comments so a comment quoting the old code is not a hit. */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Return the source text of each spawn-like call, from the call to its closing paren. */
function spawnCalls(src: string): string[] {
	const calls: string[] = [];
	const re = /\b(?:Bun\.spawn(?:Sync)?|spawn(?:Sync)?|exec(?:Sync|File|FileSync)?)\s*\(/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(src))) {
		let depth = 0;
		let i = m.index + m[0].length - 1;
		for (; i < src.length; i++) {
			if (src[i] === "(") depth++;
			else if (src[i] === ")" && --depth === 0) break;
		}
		calls.push(src.slice(m.index, i + 1));
	}
	return calls;
}

function tsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name === "work") continue;
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...tsFiles(p));
		else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(p);
	}
	return out;
}

describe("static: no spawn in benchmarks/autoresearch forwards the parent environment", () => {
	test("no spawn-like call spreads or passes process.env", () => {
		const offenders: string[] = [];
		for (const file of tsFiles(join(REPO_ROOT, "benchmarks", "autoresearch"))) {
			for (const call of spawnCalls(stripComments(readFileSync(file, "utf-8")))) {
				if (/\.\.\.\s*process\.env\b|env\s*:\s*process\.env\b/.test(call)) {
					offenders.push(`${file.slice(REPO_ROOT.length + 1)}: ${call.split("\n")[0]}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test("every spawn in execution-grader.ts (the one that runs model code) passes an explicit childEnv()", () => {
		// A spawn with no env inherits process.env, which is the same leak.
		const src = stripComments(
			readFileSync(join(REPO_ROOT, "benchmarks", "autoresearch", "execution-grader.ts"), "utf-8"),
		);
		const calls = spawnCalls(src);
		expect(calls.length).toBeGreaterThanOrEqual(2);
		for (const call of calls) expect(call).toMatch(/env\s*:\s*childEnv\(/);
	});
});
