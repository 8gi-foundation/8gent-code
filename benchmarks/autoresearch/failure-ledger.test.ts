import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CombinedGradeResult, ExecutionGradeResult } from "../types";
import {
	EVIDENCE_DROPPED,
	EVIDENCE_MAX,
	MIN_LABEL_COUNT,
	evidenceSnippet,
	execEvidence,
	gateMutations,
	labelChecks,
	labelCounts,
	labelGrade,
	ledgerEnabled,
	readRows,
	recordRunError,
	runSummary,
	taskLabel,
} from "./failure-ledger";

const ON = { EIGHT_FAILURE_LEDGER: "1" };
const OFF = {};
const RUN = "autoresearch-2026-10-03T00:00:00.000Z";

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

function gate(
	env: Record<string, string>,
	g: CombinedGradeResult,
	mutations: string[],
	taskId = "BT001",
	run = RUN,
	path = ledger,
) {
	return gateMutations({
		env,
		ledgerPath: path,
		run,
		runId: `${run}-iter1`,
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
			expect(r.dropped).toEqual([]);
			expect(r.row).toBeNull();
			expect(r.note).toBeNull();
		}
		expect(recordRunError(OFF, ledger, RUN, `${RUN}-iter1`, "BT001", new Error("boom"))).toEqual({
			row: null,
			note: null,
		});
		expect(runSummary(OFF, ledger, RUN)).toEqual([]);
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
	test("no tests ran", () => {
		const g = grade({ execution: exec({ totalTests: 0, failedTests: 0, stderr: "SyntaxError: x" }) });
		expect(labelGrade(g, opts)).toMatchObject({ label: "exec-no-tests-ran", check: "execution" });
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
	test("pilot checks (trial only, not wired): first failing check names the failure", () => {
		const l = labelChecks([
			{ name: "tui_started", pass: true },
			{ name: "turn_ok", pass: false, detail: "no turn end" },
			{ name: "reply_visible", pass: false },
		]);
		expect(l).toEqual({ label: "turn_ok", check: "pilot", evidence: "no turn end" });
		expect(labelChecks([{ name: "a", pass: true }])).toBeNull();
	});
});

describe("gate: task + label, this run only", () => {
	test(`a task's mutations apply once it fails with the same label ${MIN_LABEL_COUNT} times`, () => {
		const r1 = gate(ON, grade(), ["m1"]);
		const r2 = gate(ON, grade(), ["m2"]);
		const r3 = gate(ON, grade(), ["m3"]);
		expect([r1.apply, r2.apply, r3.apply]).toEqual([[], [], ["m3"]]);
		expect([r1.dropped, r2.dropped, r3.dropped]).toEqual([["m1"], ["m2"], []]);
		expect(r3.seen).toBe(3);
		expect(r1.note).toContain("BT001:exec-all-tests-failed (seen 1x this run)");
		expect(r1.note).toContain("dropped until seen 3x (regenerated on the next failure)");
		expect(r1.note).not.toContain("held");
	});

	test("three different tasks sharing a label do not open the gate", () => {
		const rs = ["A", "B", "C"].map((t) => gate(ON, grade(), [`${t}-m`], t));
		expect(rs.map((r) => r.apply)).toEqual([[], [], []]);
		expect(rs.map((r) => r.seen)).toEqual([1, 1, 1]);
	});

	test("same task, different label, counts separately", () => {
		gate(ON, grade(), ["m"]);
		gate(ON, grade(), ["m"]);
		const t = gate(ON, grade({ execution: exec({ timedOut: true }) }), ["t"]);
		expect(t.apply).toEqual([]);
		expect(t.seen).toBe(1);
	});

	test("rows from an earlier run do not count", () => {
		for (let i = 0; i < 3; i++) gate(ON, grade(), ["old"], "BT001", "autoresearch-earlier");
		const now = gate(ON, grade(), ["new"]);
		expect(now.seen).toBe(1);
		expect(now.apply).toEqual([]);
		expect(readRows(ledger).length).toBe(4);
	});

	test("one row per failing task with run, run id, task id, label; passing writes nothing", () => {
		gate(ON, grade({ score: 95 }), [], "PASS");
		expect(existsSync(ledger)).toBe(false);
		gate(ON, grade(), ["m"], "BT002");
		recordRunError(ON, ledger, RUN, `${RUN}-iter1`, "BT003", new Error("All temps failed for BT003"));
		const rows = readRows(ledger);
		expect(rows.length).toBe(2);
		expect(rows[0]).toMatchObject({
			run: RUN,
			run_id: `${RUN}-iter1`,
			task_id: "BT002",
			label: "exec-all-tests-failed",
			score: 20,
		});
		expect(rows[1]).toMatchObject({ task_id: "BT003", label: "run-error", check: "run", score: null });
		expect(labelCounts(rows, taskLabel)).toEqual([
			["BT002:exec-all-tests-failed", 1],
			["BT003:run-error", 1],
		]);
	});

	test("torn lines are skipped", () => {
		gate(ON, grade(), ["m"]);
		writeFileSync(ledger, `${readFileSync(ledger, "utf-8")}{not json\n\n`);
		expect(readRows(ledger).length).toBe(1);
	});
});

describe("end-of-iteration summary", () => {
	test("top 3 task:label counts for this run only", () => {
		for (let i = 0; i < 3; i++) gate(ON, grade(), ["m"], "A");
		for (let i = 0; i < 2; i++) gate(ON, grade(), ["m"], "B");
		gate(ON, grade(), ["m"], "C");
		gate(ON, grade(), ["m"], "D");
		for (let i = 0; i < 5; i++) gate(ON, grade(), ["m"], "Z", "autoresearch-earlier");
		expect(runSummary(ON, ledger, RUN)).toEqual([
			"  Ledger top 3 (task:label, this run):",
			"    3x A:exec-all-tests-failed",
			"    2x B:exec-all-tests-failed",
			"    1x C:exec-all-tests-failed",
		]);
		expect(runSummary(ON, ledger, "autoresearch-none")).toEqual([
			"  Ledger: no failures recorded this run",
		]);
	});
});

describe("a ledger failure never escapes", () => {
	test("unwritable ledger path: gate drops mutations with a note, run error and summary do not throw", () => {
		const blocker = join(dir, "not-a-dir");
		writeFileSync(blocker, "x");
		const bad = join(blocker, "failure-ledger.jsonl");
		const r = gate(ON, grade(), ["m"], "BT001", RUN, bad);
		expect(r.apply).toEqual([]);
		expect(r.dropped).toEqual(["m"]);
		expect(r.note).toContain("ledger error, mutations dropped");
		const e = recordRunError(ON, bad, RUN, `${RUN}-iter1`, "BT001", new Error("x"));
		expect(e.row).toBeNull();
		expect(e.note).toContain("ledger error");
		expect(Array.isArray(runSummary(ON, bad, RUN))).toBe(true);
	});

	test("the grade object is never modified", () => {
		const g = grade();
		const before = JSON.stringify(g);
		for (let i = 0; i < 3; i++) gate(ON, g, ["m"]);
		gate(ON, g, ["m"], "BT001", RUN, join(dir, "x", "\0bad"));
		expect(JSON.stringify(g)).toBe(before);
	});
});

describe("loop wiring (static: the loop calls main() on import and needs a model)", () => {
	const src = readFileSync(join(import.meta.dir, "autoresearch-loop.ts"), "utf-8");
	test("mutations applied are the gate's, scoped to one run, with a summary", () => {
		expect(src).toContain("for (const m of apply)");
		expect(src).toContain("let apply: string[] = muts;");
		expect(src).toContain("run: ledgerRun,");
		expect(src).toContain("const ledgerRun = `autoresearch-${state.startedAt}`;");
		expect(src).toContain("runSummary(process.env, FAILURE_LEDGER, ledgerRun)");
		expect(src).not.toContain("for (const m of muts)");
	});
	test("both ledger calls sit inside their own try/catch", () => {
		const g = src.indexOf("gateMutations({");
		const r = src.indexOf("recordRunError(\n");
		expect(g).toBeGreaterThan(0);
		expect(r).toBeGreaterThan(0);
		expect(src.slice(src.lastIndexOf("try {", g), g)).not.toContain("}");
		expect(src.slice(src.lastIndexOf("try {", r), r)).not.toContain("}");
		expect(src.slice(g, src.indexOf("for (const m of apply)"))).toContain("catch (ledgerErr");
	});
});

describe("evidence", () => {
	test("exec evidence starts at the first (fail) or error: line", () => {
		const out = "bun test v1\nsetup ok\nsetup ok 2\n(fail) Queue > retries [2ms]\n  Expected: 3\n";
		expect(execEvidence(out, "")).toBe("(fail) Queue > retries [2ms]\n  Expected: 3\n");
		expect(execEvidence("", "noise\nTypeError: x is undefined\n")).toBe("TypeError: x is undefined\n");
		expect(execEvidence("no markers here", "")).toBe("no markers here");
	});

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
		expect(s).toBe(EVIDENCE_DROPPED);
	});

	test("one long token with no boundary says so instead of going blank", () => {
		expect(evidenceSnippet("A".repeat(5000))).toBe(EVIDENCE_DROPPED);
		expect(evidenceSnippet("")).toBe("");
	});

	test("linear on long adversarial input, including just under the window", () => {
		const inputs = [
			`sk-${"A".repeat(200_000)}`,
			" \t\n".repeat(200_000),
			`password=${"Zz9!".repeat(100_000)}`,
			"x".repeat(1_000_000),
			`sk-${"A".repeat(3996)}`,
			`password=${"Zz9!".repeat(997)}`,
			`xoxb-${"a-".repeat(1997)}`,
			`ghp_${"a".repeat(3995)}`,
		];
		const t0 = performance.now();
		for (const i of inputs) evidenceSnippet(i);
		expect(performance.now() - t0).toBeLessThan(500);
	});
});
