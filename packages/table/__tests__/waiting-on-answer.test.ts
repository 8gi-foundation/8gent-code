/**
 * isWaitingOnAnswer (packages/table/helm-bridge.ts).
 *
 * The question detector decides whether a worker is left ALIVE for the human or
 * reaped, so both directions cost something real: a miss throws away a running
 * session and its question, a false positive re-asks a question that was already
 * answered.
 *
 * Every "answered" fixture below is a real captured tail, not an invented one.
 * The first came out of the live bridge run on 2026-08-06 that found the bug:
 * the worker was asked, answered "2" through the /reply path, printed its
 * result - and the bridge still reported needs_input, because the original
 * prompt was three lines up in the scrollback. In the Table that is an infinite
 * ask loop, so it is guarded here rather than left to the next dogfood.
 */

import { describe, expect, it } from "bun:test";
import { isWaitingOnAnswer } from "../helm-bridge";

const WAITING_NUMBERED = [
	"Which base branch should I use?",
	"> 1. main",
	"  2. develop",
].join("\n");

const ANSWERED_NUMBERED = [
	"Which base branch should I use?",
	"> 1. main",
	"  2. develop",
	"2",
	"RESUMED-WITH:[2]",
].join("\n");

describe("isWaitingOnAnswer", () => {
	it("sees a numbered-choice cursor that is still waiting", () => {
		expect(isWaitingOnAnswer(WAITING_NUMBERED)).toBe(true);
	});

	it("does NOT re-ask once the answer landed and the worker moved on", () => {
		// The exact regression: same prompt, still on screen, already answered.
		expect(isWaitingOnAnswer(ANSWERED_NUMBERED)).toBe(false);
	});

	it("treats the ask's own option list as part of the ask, not a response", () => {
		// The menu prints BELOW the cursor line. If option lines counted as
		// "something happened after the question", every real question would be
		// read as already answered and every asking worker would be reaped.
		const menu = ["❯ 1. main", "  2. develop", "  3. release"].join("\n");
		expect(isWaitingOnAnswer(menu)).toBe(true);
	});

	it("handles explicit confirm prompts in both states", () => {
		expect(isWaitingOnAnswer("Overwrite the file? [y/n]")).toBe(true);
		expect(isWaitingOnAnswer("Overwrite the file? [y/n]\ny\nwrote 3 files")).toBe(false);
	});

	it("stays quiet on ordinary output with no question in it", () => {
		expect(isWaitingOnAnswer("running tests\n42 pass\n0 fail")).toBe(false);
		expect(isWaitingOnAnswer("")).toBe(false);
	});

	it("ignores a question that has scrolled out of the tail window", () => {
		// Only the last 12 non-empty lines are considered: an ask buried far above
		// is history, not a live prompt.
		const scrolled = [WAITING_NUMBERED, ...Array.from({ length: 14 }, (_, i) => `step ${i}`)].join("\n");
		expect(isWaitingOnAnswer(scrolled)).toBe(false);
	});
});
