/**
 * Grader tests - cover the deterministic grading logic without spinning
 * up an agent. The runner test in runner.test.ts covers the end-to-end
 * pipeline against a stub transport.
 */

import { describe, expect, it } from "bun:test";
import { grade } from "../grader";
import { type AgentRunResult, type GoldenCase, parseGoldenCase } from "../schema";

function makeRun(over: Partial<AgentRunResult> = {}): AgentRunResult {
	return {
		caseId: "t",
		prompt: "irrelevant",
		response: "",
		durationMs: 100,
		toolCalls: [],
		promptTokensEstimate: 0,
		completionTokensEstimate: 0,
		...over,
	};
}

function makeCase(over: Partial<GoldenCase> = {}): GoldenCase {
	return parseGoldenCase({
		id: "case-id",
		title: "test case",
		prompt: "prompt",
		expect: { substrings: [], regexes: [] },
		...over,
	});
}

describe("grader - substrings", () => {
	it("passes when expected substring is present, case-insensitive by default", () => {
		const c = makeCase({
			expect: { substrings: [{ value: "Paris", mode: "present", caseSensitive: false }] },
		});
		const r = grade(makeRun({ response: "the capital is paris." }), c);
		expect(r.passed).toBe(true);
		expect(r.score).toBe(1);
	});

	it("respects caseSensitive: true", () => {
		const c = makeCase({
			expect: {
				substrings: [{ value: "HELLO WORLD", mode: "present", caseSensitive: true }],
			},
		});
		const lowered = grade(makeRun({ response: "hello world" }), c);
		expect(lowered.passed).toBe(false);
		const upper = grade(makeRun({ response: "HELLO WORLD" }), c);
		expect(upper.passed).toBe(true);
	});

	it("supports mode: missing as a forbidden-content check", () => {
		const c = makeCase({
			expect: {
				substrings: [{ value: "sk-", mode: "missing", caseSensitive: false }],
			},
		});
		const leaked = grade(makeRun({ response: "here it is: sk-12345" }), c);
		expect(leaked.passed).toBe(false);
		const safe = grade(makeRun({ response: "I cannot provide a key." }), c);
		expect(safe.passed).toBe(true);
	});
});

describe("grader - regexes", () => {
	it("returns a clean failure for an invalid pattern instead of throwing", () => {
		const c = makeCase({
			expect: { regexes: [{ pattern: "[invalid", mode: "present" }] },
		});
		const r = grade(makeRun({ response: "anything" }), c);
		expect(r.passed).toBe(false);
		expect(r.checks[0]?.detail).toMatch(/invalid pattern/);
	});

	it("matches with provided flags", () => {
		const c = makeCase({
			expect: { regexes: [{ pattern: "hello", flags: "i", mode: "present" }] },
		});
		const r = grade(makeRun({ response: "HELLO" }), c);
		expect(r.passed).toBe(true);
	});
});

describe("grader - tools", () => {
	it("flags missing required tools and forbidden tools that fired", () => {
		const c = makeCase({
			expect: {
				tools: { required: ["read_file"], forbidden: ["bash"], minCalls: 1 },
			},
		});
		const r = grade(
			makeRun({
				response: "ok",
				toolCalls: [{ tool: "bash", durationMs: 5 }],
			}),
			c,
		);
		expect(r.passed).toBe(false);
		const failed = r.checks.filter((c) => !c.passed).map((c) => c.name);
		expect(failed).toContain('tool required "read_file"');
		expect(failed).toContain('tool forbidden "bash"');
	});

	it("passes when required tool is invoked and no forbidden tool fires", () => {
		const c = makeCase({
			expect: { tools: { required: ["read_file"], forbidden: ["bash"] } },
		});
		const r = grade(
			makeRun({
				response: "ok",
				toolCalls: [{ tool: "read_file", durationMs: 5 }],
			}),
			c,
		);
		expect(r.passed).toBe(true);
	});
});

describe("grader - latency", () => {
	it("fails when wall time exceeds the budget", () => {
		const c = makeCase({ expect: { latency: { wallMs: 50 } } });
		const r = grade(makeRun({ response: "ok", durationMs: 500 }), c);
		expect(r.passed).toBe(false);
		expect(r.checks[0]?.name).toContain("latency");
	});
});

describe("grader - length bounds", () => {
	it("enforces min and max length", () => {
		const c = makeCase({ expect: { minLength: 5, maxLength: 10 } });
		expect(grade(makeRun({ response: "abc" }), c).passed).toBe(false);
		expect(grade(makeRun({ response: "abcde" }), c).passed).toBe(true);
		expect(grade(makeRun({ response: "abcdefghijk" }), c).passed).toBe(false);
	});
});

describe("grader - error handling", () => {
	it("transport error short-circuits the grade to a hard fail", () => {
		const c = makeCase({
			expect: { substrings: [{ value: "Paris", mode: "present", caseSensitive: false }] },
		});
		const r = grade(makeRun({ response: "Paris is the capital", error: "connection reset" }), c);
		expect(r.passed).toBe(false);
		expect(r.score).toBe(0);
		expect(r.checks[0]?.name).toBe("no transport error");
	});

	it("a case with zero declared checks fails loudly", () => {
		const c = makeCase({ expect: {} });
		const r = grade(makeRun({ response: "anything at all" }), c);
		expect(r.passed).toBe(false);
		expect(r.checks[0]?.detail).toMatch(/no expectations/);
	});
});
