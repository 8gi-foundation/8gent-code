import { describe, expect, test } from "bun:test";
import { programStatusSequence, programStatusEnabled, deriveProgramState, createProgramStatusEmitter } from "./program-status.js";

const ESC = "\x1b";

describe("programStatusSequence bytes", () => {
	test("each state is OSC 7501 ; state=... ST", () => {
		for (const s of ["idle", "working", "done", "error", "clear"] as const) {
			expect(programStatusSequence(s)).toBe(`${ESC}]7501;state=${s}:app=8gent${ESC}\\`);
		}
	});
	test("blocked carries kind=permission", () => {
		expect(programStatusSequence("blocked")).toBe(`${ESC}]7501;state=blocked:kind=permission:app=8gent${ESC}\\`);
	});
	test("sequence stays far under the 4096 byte limit", () => {
		expect(programStatusSequence("blocked").length).toBeLessThan(100);
	});
});

describe("guards", () => {
	test("enabled only on a TTY", () => {
		expect(programStatusEnabled({ isTTY: true }, {})).toBe(true);
		expect(programStatusEnabled({ isTTY: false }, {})).toBe(false);
		expect(programStatusEnabled({}, {})).toBe(false);
	});
	test("EIGHT_NO_PROGRAM_STATUS opts out", () => {
		expect(programStatusEnabled({ isTTY: true }, { EIGHT_NO_PROGRAM_STATUS: "1" })).toBe(false);
		expect(programStatusEnabled({ isTTY: true }, { EIGHT_NO_PROGRAM_STATUS: "0" })).toBe(true);
	});
	test("TERM=dumb is off", () => {
		expect(programStatusEnabled({ isTTY: true }, { TERM: "dumb" })).toBe(false);
	});
});

describe("deriveProgramState", () => {
	test("approval beats processing", () => {
		expect(deriveProgramState({ isProcessing: true, approvalPending: true, lastTurn: null })).toBe("blocked");
	});
	test("processing is working", () => {
		expect(deriveProgramState({ isProcessing: true, approvalPending: false, lastTurn: null })).toBe("working");
	});
	test("finished turn is done or error, no turn is idle", () => {
		expect(deriveProgramState({ isProcessing: false, approvalPending: false, lastTurn: "ok" })).toBe("done");
		expect(deriveProgramState({ isProcessing: false, approvalPending: false, lastTurn: "error" })).toBe("error");
		expect(deriveProgramState({ isProcessing: false, approvalPending: false, lastTurn: null })).toBe("idle");
	});
});

describe("emitter", () => {
	function make(isTTY: boolean, env = {}) {
		const out: string[] = [];
		return { out, em: createProgramStatusEmitter({ isTTY, write: (s: string) => void out.push(s) }, env) };
	}
	test("writes nothing when not a TTY", () => {
		const { out, em } = make(false);
		em.set("working");
		em.clear();
		expect(out).toEqual([]);
	});
	test("writes nothing when opted out", () => {
		const { out, em } = make(true, { EIGHT_NO_PROGRAM_STATUS: "1" });
		em.set("working");
		expect(out).toEqual([]);
	});
	test("dedupes repeated states and clears once", () => {
		const { out, em } = make(true);
		em.set("working");
		em.set("working");
		em.set("done");
		em.clear();
		em.clear();
		expect(out).toEqual([programStatusSequence("working"), programStatusSequence("done"), programStatusSequence("clear")]);
	});
});
