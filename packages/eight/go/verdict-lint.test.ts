/**
 * Verdict copy lint.
 *
 * Three layers of coverage:
 *   1. Every exported constant must pass assertNoBannedTokens. If anyone
 *      edits verdicts.ts and types "I've" or "—" by reflex, this trips.
 *   2. assembleVerdict produces the exact strings we promise the rest of
 *      the system. Snapshot-by-equality, not inspection.
 *   3. assertNoBannedTokens itself must throw on a known offender,
 *      otherwise the lint would silently pass on real code.
 */

import { describe, expect, test } from "bun:test";
import {
	BANNED_TOKENS,
	BannedTokenError,
	VERDICT_ABANDONED,
	VERDICT_DONE,
	VERDICT_NEEDS_YOU,
	VERDICT_STILL_GOING,
	VERDICT_STOPPED,
	VERDICT_STUCK,
	assembleVerdict,
	assertNoBannedTokens,
} from "./verdicts";

describe("verdict constants", () => {
	test("VERDICT_DONE passes lint", () => {
		expect(() => assertNoBannedTokens(VERDICT_DONE)).not.toThrow();
	});
	test("VERDICT_STOPPED passes lint", () => {
		expect(() => assertNoBannedTokens(VERDICT_STOPPED)).not.toThrow();
	});
	test("VERDICT_NEEDS_YOU passes lint", () => {
		expect(() => assertNoBannedTokens(VERDICT_NEEDS_YOU)).not.toThrow();
	});
	test("VERDICT_STILL_GOING passes lint", () => {
		expect(() => assertNoBannedTokens(VERDICT_STILL_GOING)).not.toThrow();
	});
	test("VERDICT_STUCK passes lint", () => {
		expect(() => assertNoBannedTokens(VERDICT_STUCK)).not.toThrow();
	});
	test("VERDICT_ABANDONED passes lint", () => {
		expect(() => assertNoBannedTokens(VERDICT_ABANDONED)).not.toThrow();
	});

	test("constants are exactly the strings we contracted with the boardroom", () => {
		expect(VERDICT_DONE).toBe("Done. Goal met at turn {n}.");
		expect(VERDICT_STOPPED).toBe("Stopped. {reason}.");
		expect(VERDICT_NEEDS_YOU).toBe("Needs you. {what}.");
		expect(VERDICT_STILL_GOING).toBe("Still going. Sub-goal {x} of {y}.");
		expect(VERDICT_STUCK).toBe(
			"Stuck. Needs you - last attempt failed three times the same way.",
		);
		expect(VERDICT_ABANDONED).toBe("Stopped. Couldn't get past {reason}.");
	});
});

describe("assembleVerdict", () => {
	test("done renders turn number", () => {
		expect(assembleVerdict("done", { kind: "done", n: 7 })).toBe(
			"Done. Goal met at turn 7.",
		);
	});

	test("stopped renders reason", () => {
		expect(
			assembleVerdict("stopped", {
				kind: "stopped",
				reason: "turn budget reached",
			}),
		).toBe("Stopped. turn budget reached.");
	});

	test("needs_you renders question", () => {
		expect(
			assembleVerdict("needs_you", {
				kind: "needs_you",
				what: "confirm the destination branch",
			}),
		).toBe("Needs you. confirm the destination branch.");
	});

	test("still_going renders sub-goal counter", () => {
		expect(
			assembleVerdict("still_going", { kind: "still_going", x: 2, y: 5 }),
		).toBe("Still going. Sub-goal 2 of 5.");
	});

	test("stuck has no interpolation", () => {
		expect(assembleVerdict("stuck", { kind: "stuck" })).toBe(
			"Stuck. Needs you - last attempt failed three times the same way.",
		);
	});

	test("abandoned renders blocker", () => {
		expect(
			assembleVerdict("abandoned", {
				kind: "abandoned",
				reason: "the test command kept exiting non-zero",
			}),
		).toBe("Stopped. Couldn't get past the test command kept exiting non-zero.");
	});

	test("trailing period in free text is collapsed", () => {
		expect(
			assembleVerdict("stopped", {
				kind: "stopped",
				reason: "user pressed Ctrl-C.",
			}),
		).toBe("Stopped. user pressed Ctrl-C.");
	});

	test("em dash in free text is normalized to hyphen", () => {
		const out = assembleVerdict("stopped", {
			kind: "stopped",
			reason: "build failed test suite",
		});
		expect(out.includes("—")).toBe(false);
	});

	test("kind/fields mismatch throws", () => {
		expect(() =>
			assembleVerdict("done", { kind: "stopped", reason: "x" } as never),
		).toThrow(/kind\/fields mismatch/);
	});
});

describe("assertNoBannedTokens negative tests", () => {
	test("flags em dash", () => {
		expect(() => assertNoBannedTokens("Done — finally")).toThrow(BannedTokenError);
	});

	test("flags first-person AI-speak (I've)", () => {
		expect(() =>
			assertNoBannedTokens("I've completed the task"),
		).toThrow(BannedTokenError);
	});

	test("flags vendor name Claude", () => {
		expect(() =>
			assertNoBannedTokens("Claude finished the run"),
		).toThrow(BannedTokenError);
	});

	test("flags inflated language (successfully)", () => {
		expect(() =>
			assertNoBannedTokens("Run completed successfully"),
		).toThrow(BannedTokenError);
	});

	test("flags AI as standalone word", () => {
		expect(() => assertNoBannedTokens("The AI did it")).toThrow(
			BannedTokenError,
		);
	});

	test("does NOT flag 'ai' inside 'again' (word-boundary safety)", () => {
		expect(() =>
			assertNoBannedTokens("Goal met. Try again on a fresh branch."),
		).not.toThrow();
	});

	test("does NOT flag 'ai' inside 'fail'", () => {
		expect(() => assertNoBannedTokens("The check did not fail.")).not.toThrow();
	});

	test("does NOT flag 'model' inside 'modelling' if exact word absent", () => {
		// Word-boundary; "modelling" is a different word.
		expect(() => assertNoBannedTokens("modelling")).not.toThrow();
	});

	test("flags 'working on' phrase", () => {
		expect(() => assertNoBannedTokens("Working on it now")).toThrow(
			BannedTokenError,
		);
	});

	test("flags 'great news' phrase", () => {
		expect(() =>
			assertNoBannedTokens("Great news everyone"),
		).toThrow(BannedTokenError);
	});

	test("BANNED_TOKENS is non-empty (sanity)", () => {
		expect(BANNED_TOKENS.length).toBeGreaterThan(0);
	});

	test("BannedTokenError carries token + offending text", () => {
		try {
			assertNoBannedTokens("The AI shipped it");
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(BannedTokenError);
			const e = err as BannedTokenError;
			expect(e.token).toBe("AI");
			expect(e.text).toBe("The AI shipped it");
		}
	});
});
