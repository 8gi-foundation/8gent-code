import { describe, expect, test } from "bun:test";
import { programStatusSequence, programStatusEnabled, deriveProgramState, createProgramStatusEmitter, installProgramStatusCleanup } from "./program-status.js";

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

describe("cleanup on exit and signals", () => {
	function fakeProc(otherSigintListeners = 0) {
		const l: Record<string, Array<() => void>> = {};
		const killed: string[] = [];
		return {
			l, killed,
			pid: 1,
			on: (e: string, f: () => void) => void (l[e] ??= []).push(f),
			removeListener: (e: string, f: () => void) => void (l[e] = (l[e] ?? []).filter((x) => x !== f)),
			listenerCount: (e: string) => (l[e]?.length ?? 0) + (e === "SIGINT" ? otherSigintListeners : 0),
			kill: (_pid: number, s: string) => void killed.push(s),
		};
	}
	function setup(isTTY = true, env = {}, others = 0) {
		const out: string[] = [];
		const em = createProgramStatusEmitter({ isTTY, write: (s: string) => void out.push(s) }, env);
		em.set("working");
		out.length = 0;
		const proc = fakeProc(others);
		installProgramStatusCleanup(em, proc);
		return { out, proc };
	}
	test("SIGINT clears once and re-raises", () => {
		const { out, proc } = setup();
		proc.l.SIGINT[0]();
		expect(out).toEqual([programStatusSequence("clear")]);
		expect(proc.killed).toEqual(["SIGINT"]);
		expect(proc.l.SIGINT.length).toBe(0);
	});
	test("SIGTERM clears and re-raises", () => {
		const { out, proc } = setup();
		proc.l.SIGTERM[0]();
		expect(out).toEqual([programStatusSequence("clear")]);
		expect(proc.killed).toEqual(["SIGTERM"]);
	});
	test("does not re-raise when another handler exists", () => {
		const { proc } = setup(true, {}, 1);
		proc.l.SIGINT[0]();
		expect(proc.killed).toEqual([]);
	});
	test("exit after signal does not clear twice", () => {
		const { out, proc } = setup();
		proc.l.SIGINT[0]();
		proc.l.exit[0]();
		expect(out).toEqual([programStatusSequence("clear")]);
	});
	test("guards: non-TTY and opt-out write nothing", () => {
		for (const [tty, env] of [[false, {}], [true, { EIGHT_NO_PROGRAM_STATUS: "1" }], [true, { TERM: "dumb" }]] as const) {
			const { out, proc } = setup(tty, env);
			proc.l.exit[0]();
			proc.l.SIGTERM[0]();
			expect(out).toEqual([]);
		}
	});
});
