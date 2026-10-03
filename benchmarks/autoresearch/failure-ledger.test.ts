import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CombinedGradeResult, ExecutionGradeResult } from "../types";
import {
	EVIDENCE_MAX,
	MIN_LABEL_COUNT,
	evidenceSnippet,
	gateMutations,
	labelChecks,
	labelCounts,
	labelGrade,
	ledgerEnabled,
	readRows,
	recordRunError,
} from "./failure-ledger";

const ON = { EIGHT_FAILURE_LEDGER: "1" };
const OFF = {};

function exec(over: Partial<ExecutionGradeResult> = {}): ExecutionGradeResult {
	return {
		score: 0,
		totalTests: 4,
		passedTests: 0,
		failedTests: 4,
		stdout: "",
		stderr: "expect(received).toBe(expected)",
		timedOut: false,
		durationMs: 10,
		...over,
	} as ExecutionGradeResult;
}

function grade(over: Partial<CombinedGradeResult> = {}): CombinedGradeResult {
	return {
		score: 20,
		execution: exec(),
		keyword: { score: 50, matchedKeywords: ["a"], missedKeywords: ["b"] },
		method: "execution+keyword",
		...over,
	};
}

const opts = { passThreshold: 80, hasTestHarness: true };

let dir: string;
let ledger: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "failure-ledger-"));
	ledger = join(dir, "run", "failure-ledger.jsonl");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	expect(existsSync(dir)).toBe(false);
});

function gate(env: Record<string, string>, g: CombinedGradeResult, mutations: string[], taskId = "BT001") {
	return gateMutations({
		env,
		ledgerPath: ledger,
		runId: "run-1",
		taskId,
		grade: g,
		hasTestHarness: true,
		passThreshold: 80,
		mutations,
	});
}

describe("flag", () => {
	test("only the exact string 1 turns it on", () => {
		expect(ledgerEnabled({ EIGHT_FAILURE_LEDGER: "1" })).toBe(true);
		for (const v of ["", "0", "true", "yes", " 1", "1 ", "01"]) {
			expect(ledgerEnabled({ EIGHT_FAILURE_LEDGER: v })).toBe(false);
		}
		expect(ledgerEnabled({})).toBe(false);
	});
});

describe("flag off is unchanged", () => {
	test("mutations come back as the same array and nothing is written", () => {
		const muts = ["[BT001] m1", "[BT001] m2"];
		for (let i = 0; i < 5; i++) {
			const r = gate(OFF, grade(), muts);
			expect(r.apply).toBe(muts);
			expect(r.deferred).toEqual([]);
			expect(r.row).toBeNull();
			expect(r.note).toBeNull();
		}
		expect(recordRunError(OFF, ledger, "run-1", "BT001", new Error("boom"))).toBeNull();
		expect(existsSync(ledger)).toBe(false);
		expect(readdirSync(dir)).toEqual([]);
	});

	test("does not touch HOME", () => {
		const home = process.env.HOME ?? "";
		const before = existsSync(home) ? readdirSync(home).sort() : [];
		gate(OFF, grade(), ["m"]);
		gate(ON, grade(), ["m"]);
		const after = existsSync(home) ? readdirSync(home).sort() : [];
		expect(after).toEqual(before);
	});
});

describe("labels come from the grader's sub-checks, one per run", () => {
	test("passing run has no label", () => {
		expect(labelGrade(grade({ score: 80 }), opts)).toBeNull();
	});
	test("timeout wins over test counts", () => {
		expect(labelGrade(grade({ execution: exec({ timedOut: true }) }), opts)?.label).toBe("exec-timeout");
	});
	test("no tests ran is a crash", () => {
		const g = grade({ execution: exec({ totalTests: 0, failedTests: 0, stderr: "SyntaxError: x" }) });
		expect(labelGrade(g, opts)).toMatchObject({ label: "exec-crash", check: "execution" });
	});
	test("all vs some tests failed", () => {
		expect(labelGrade(grade(), opts)?.label).toBe("exec-all-tests-failed");
		const some = grade({ execution: exec({ passedTests: 2, failedTests: 2 }) });
		expect(labelGrade(some, opts)?.label).toBe("exec-some-tests-failed");
	});
	test("no code with a harness is an extraction failure", () => {
		const g = grade({ execution: null, method: "keyword-only" });
		expect(labelGrade(g, opts)).toMatchObject({ label: "no-code-extracted", check: "extraction" });
	});
	test("keyword-only task, or execution passed, falls to keyword-miss", () => {
		const g = grade({ execution: null, method: "keyword-only" });
		expect(labelGrade(g, { ...opts, hasTestHarness: false })?.label).toBe("keyword-miss");
		const passedExec = grade({ execution: exec({ passedTests: 4, failedTests: 0, score: 100 }), score: 75 });
		expect(labelGrade(passedExec, opts)).toMatchObject({ label: "keyword-miss", check: "keyword" });
	});
	test("nothing specific left is below-threshold", () => {
		const g = grade({
			execution: exec({ passedTests: 4, failedTests: 0 }),
			keyword: { score: 100, matchedKeywords: ["a"], missedKeywords: [] },
		});
		expect(labelGrade(g, opts)?.label).toBe("below-threshold");
	});
	test("pilot checks: first failing check names the failure", () => {
		const l = labelChecks([
			{ name: "tui_started", pass: true },
			{ name: "turn_ok", pass: false, detail: "no turn end" },
			{ name: "reply_visible", pass: false },
		]);
		expect(l).toEqual({ label: "turn_ok", check: "pilot", evidence: "no turn end" });
		expect(labelChecks([{ name: "a", pass: true }])).toBeNull();
	});
});

describe("gate", () => {
	test(`mutations are held until the label is seen ${MIN_LABEL_COUNT} times`, () => {
		const r1 = gate(ON, grade(), ["m1"], "A");
		const r2 = gate(ON, grade(), ["m2"], "B");
		const r3 = gate(ON, grade(), ["m3"], "C");
		expect([r1.apply, r2.apply, r3.apply]).toEqual([[], [], ["m3"]]);
		expect([r1.deferred, r2.deferred]).toEqual([["m1"], ["m2"]]);
		expect(r3.seen).toBe(3);
		expect(r1.note).toContain("held until seen 3x");
		// A different label starts its own count.
		const other = gate(ON, grade({ execution: exec({ timedOut: true }) }), ["t1"], "D");
		expect(other.apply).toEqual([]);
		expect(other.seen).toBe(1);
	});

	test("one row per failing task with run id, task id, label; passing writes nothing", () => {
		gate(ON, grade({ score: 95 }), [], "PASS");
		expect(existsSync(ledger)).toBe(false);
		gate(ON, grade(), ["m"], "BT002");
		recordRunError(ON, ledger, "run-1", "BT003", new Error("All temps failed for BT003"));
		const rows = readRows(ledger);
		expect(rows.length).toBe(2);
		expect(rows[0]).toMatchObject({ run_id: "run-1", task_id: "BT002", label: "exec-all-tests-failed", score: 20 });
		expect(rows[1]).toMatchObject({ task_id: "BT003", label: "run-error", check: "run", score: null });
		expect(labelCounts(rows)).toEqual([
			["exec-all-tests-failed", 1],
			["run-error", 1],
		]);
	});

	test("torn lines are skipped", () => {
		gate(ON, grade(), ["m"]);
		writeFileSync(ledger, `${readFileSync(ledger, "utf-8")}{not json\n\n`);
		expect(readRows(ledger).length).toBe(1);
	});
});

describe("evidence", () => {
	test("secrets are scrubbed and length is capped", () => {
		const token = `ghp_${"a1B2".repeat(9)}`;
		const s = evidenceSnippet(`Error: auth failed with ${token}\n${"x ".repeat(500)}`);
		expect(s).not.toContain(token);
		expect(s).toContain("[REDACTED:github_token]");
		expect(s.length).toBeLessThanOrEqual(EVIDENCE_MAX);
	});

	test("a secret cut by the scrub window is dropped, not half-leaked", () => {
		const token = `ghp_${"a1B2".repeat(9)}`;
		const pad = " ".repeat(4000 - 10);
		const s = evidenceSnippet(`${pad}${token} tail`);
		expect(s).not.toContain("ghp_");
	});

	test("linear on long adversarial input", () => {
		const inputs = [
			`sk-${"A".repeat(200_000)}`,
			" \t\n".repeat(200_000),
			`password=${"Zz9!".repeat(100_000)}`,
			"x".repeat(1_000_000),
		];
		const t0 = performance.now();
		for (const i of inputs) evidenceSnippet(i);
		expect(performance.now() - t0).toBeLessThan(500);
	});
});
