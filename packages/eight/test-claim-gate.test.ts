import { describe, expect, test } from "bun:test";
import {
	DONE_GATE_FIELD,
	TEST_CLAIM_NUDGE,
	type TestGateEntry,
	claimsTestsPass,
	isDoneGateEnabled,
	testClaimViolation,
} from "./test-claim-gate";

const write = (path = "bowling.js"): TestGateEntry => ({
	name: "write_file",
	args: { path },
	success: true,
});
const test_ = (exit: 0 | 1, command = "bun test"): TestGateEntry => ({
	name: "run_command",
	args: { command },
	success: exit === 0,
	result: exit === 0 ? "30 pass\n0 fail" : "Exit code 1:\n25 pass\n5 fail",
});
const CLAIM = "All 30 tests pass. DONE: bowling kata complete.";

describe("claimsTestsPass", () => {
	test.each([
		"All 30 tests pass",
		"tests pass",
		"The test suite passes now",
		"30 passed",
		"all tests are passing",
	])("claims: %s", (t) => expect(claimsTestsPass(t)).toBe(true));
	test.each(["I wrote bowling.js", "Run the tests to see", "2 tests failed"])("no claim: %s", (t) =>
		expect(claimsTestsPass(t)).toBe(false),
	);
});

describe("testClaimViolation (fake tool logs)", () => {
	test("write after test: gate fires", () => {
		expect(testClaimViolation([test_(0), write()], CLAIM)).toBe(true);
	});
	test("test after write, exit 0: passes", () => {
		expect(testClaimViolation([write(), test_(0)], CLAIM)).toBe(false);
	});
	test("test exit 1 then claim: fires", () => {
		expect(testClaimViolation([write(), test_(1)], CLAIM)).toBe(true);
	});
	test("evidence shape: test exit 1, then write, then claim: fires", () => {
		expect(testClaimViolation([write(), test_(1), write()], CLAIM)).toBe(true);
	});
	test("wrote, never ran a test, claims: fires", () => {
		expect(testClaimViolation([write()], CLAIM)).toBe(true);
	});
	test("no claim in the reply: never fires", () => {
		expect(testClaimViolation([test_(0), write()], "Wrote the file.")).toBe(false);
	});
	test("no write and no test run: left to the honesty gate", () => {
		expect(testClaimViolation([], CLAIM)).toBe(false);
	});
	test("every runner counts, an echo of one does not", () => {
		for (const c of [
			"npm test",
			"pnpm test",
			"yarn test",
			"pytest -q",
			"cargo test",
			"go test ./...",
			"npx vitest run",
			"npx jest",
		]) {
			expect(testClaimViolation([write(), test_(0, c)], CLAIM)).toBe(false);
		}
		expect(testClaimViolation([write(), test_(0, 'echo "bun test"')], CLAIM)).toBe(true);
	});
	test("a failed write does not move the clock", () => {
		expect(testClaimViolation([test_(0), { ...write(), success: false }], CLAIM)).toBe(false);
	});
});

describe("flag", () => {
	test("off by default; env or option turns it on; option wins", () => {
		expect(isDoneGateEnabled({})).toBe(false);
		expect(isDoneGateEnabled({ EIGHT_TEST_CLAIM_GATE: "1" })).toBe(true);
		expect(isDoneGateEnabled({ EIGHT_TEST_CLAIM_GATE: "true" })).toBe(true);
		expect(isDoneGateEnabled({ EIGHT_TEST_CLAIM_GATE: "0" })).toBe(false);
		expect(isDoneGateEnabled({}, true)).toBe(true);
		expect(isDoneGateEnabled({ EIGHT_TEST_CLAIM_GATE: "1" }, false)).toBe(false);
	});
	test("the project-check var EIGHT_DONE_GATE neither enables nor disables it", () => {
		expect(isDoneGateEnabled({ EIGHT_DONE_GATE: "1" })).toBe(false);
		expect(isDoneGateEnabled({ EIGHT_DONE_GATE: "0", EIGHT_TEST_CLAIM_GATE: "1" })).toBe(true);
	});
	test("constants", () => {
		expect(DONE_GATE_FIELD).toBe("stale_or_failing_tests");
		expect(TEST_CLAIM_NUDGE).toContain("Run the tests, then finish.");
	});
});
