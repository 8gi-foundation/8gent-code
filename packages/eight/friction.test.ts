import { describe, expect, test } from "bun:test";
import { Friction, isCorrection } from "./friction";

const T = 1_000_000;
const prev = (text: string, endedAt: number | null = T) => ({ text, endedAt });

describe("isCorrection", () => {
	test("opener words are corrections", () => {
		for (const p of [
			"no, use the other file",
			"Not that one",
			"wrong branch",
			"Actually, skip it",
			"instead do X",
		]) {
			expect(isCorrection(p, prev("add a login page to the app"), T + 999_999)).toBe(true);
		}
	});
	test("opener must be the whole first word", () => {
		for (const p of ["notes for the release please", "nothing else to add here", "now add tests"]) {
			expect(isCorrection(p, prev("add a login page to the app"), T + 999_999)).toBe(false);
		}
	});
	test("a restatement within 60 s is a correction, after 60 s it is not", () => {
		const first = "add a login page to the settings app";
		const again = "please add a login page to the settings app";
		expect(isCorrection(again, prev(first), T + 59_000)).toBe(true);
		expect(isCorrection(again, prev(first), T + 61_000)).toBe(false);
	});
	test("a different request is not a restatement", () => {
		expect(
			isCorrection(
				"now write the changelog entry",
				prev("add a login page to the settings app"),
				T + 5_000,
			),
		).toBe(false);
	});
	test("the first prompt is never a correction, even with an opener", () => {
		expect(isCorrection("no thanks", null, T)).toBe(false);
	});
	test("a prompt sent before the previous reply ended is not a restatement", () => {
		expect(
			isCorrection(
				"add a login page to the settings app",
				prev("add a login page to the settings app", null),
				T,
			),
		).toBe(false);
	});
});

describe("Friction", () => {
	test("each counter", () => {
		const f = new Friction();
		f.prompt("first thing to build", T);
		f.turnEnd(T + 1000);
		f.tool(true);
		f.tool(false);
		f.count("retries");
		f.permission("approve");
		f.permission("deny");
		f.count("honestyNudges");
		f.count("testClaimNudges");
		f.prompt("no, the other one", T + 5000);
		f.turnEnd(T + 7000);
		expect(f.record()).toEqual({
			type: "friction",
			prompts: 2,
			toolCalls: 2,
			toolErrors: 1,
			retries: 1,
			permissionPrompts: 2,
			permissionDenials: 1,
			honestyNudges: 1,
			testClaimNudges: 1,
			corrections: 1,
			turnSecondsP50: 1,
			turnSecondsMax: 2,
		});
	});
	test("p50 and max over turns", () => {
		const f = new Friction();
		let t = T;
		for (const s of [10, 2, 4, 30, 6]) {
			f.prompt(`task ${s}`, t);
			t += s * 1000;
			f.turnEnd(t);
			t += 120_000;
		}
		const r = f.record();
		expect(r.turnSecondsP50).toBe(6);
		expect(r.turnSecondsMax).toBe(30);
	});
	test("no turns: zeros, and no message text anywhere in the record", () => {
		const f = new Friction();
		f.prompt("secret-token-xyz", T);
		const r = f.record();
		expect(r.turnSecondsMax).toBe(0);
		expect(JSON.stringify(r)).not.toContain("secret");
	});
});
