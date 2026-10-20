import { describe, expect, test } from "bun:test";
import { WATCHDOG_MS, armEarlyInput, earlyRawDecision } from "./early-input.js";

function harness(
	over: { platform?: string; env?: Record<string, string | undefined>; buffered?: number } = {},
) {
	const calls: string[] = [];
	const traces: string[] = [];
	let fire: (() => void) | null = null;
	let cleared = false;
	const stdin = {
		isTTY: true,
		isRaw: false,
		readableLength: over.buffered ?? 0,
		setRawMode(m: boolean) {
			calls.push(`raw:${m}`);
			stdin.isRaw = m;
		},
		resume() {
			calls.push("resume");
		},
	};
	const handle = armEarlyInput({
		stdin,
		platform: over.platform ?? "darwin",
		env: over.env ?? {},
		trace: (l) => traces.push(l),
		setTimer: (fn, ms) => {
			expect(ms).toBe(WATCHDOG_MS);
			fire = fn;
			return 1;
		},
		clearTimer: () => {
			cleared = true;
			fire = null;
		},
	});
	return { calls, traces, handle, fire: () => fire?.(), cleared: () => cleared };
}

describe("early raw-mode watchdog (#4540)", () => {
	test("fires when no key and no Ink mount: raw off, resumed, one trace line", () => {
		const h = harness();
		expect(h.calls).toEqual(["raw:true"]);
		h.fire();
		expect(h.calls).toEqual(["raw:true", "raw:false", "resume"]);
		expect(h.traces).toHaveLength(1);
		expect(h.traces[0]).toContain("watchdog");
	});

	test("does not fire its restore when a key arrived", () => {
		const h = harness({ buffered: 1 });
		h.fire();
		expect(h.calls).toEqual(["raw:true"]);
		expect(h.traces).toEqual([]);
	});

	test("does not fire once Ink has mounted", () => {
		const h = harness();
		h.handle.markMounted();
		expect(h.cleared()).toBe(true);
		h.fire();
		expect(h.calls).toEqual(["raw:true"]);
		expect(h.traces).toEqual([]);
	});
});

describe("win32 skip (#4540)", () => {
	test("win32 skips raw mode and traces the skip", () => {
		const h = harness({ platform: "win32" });
		expect(h.calls).toEqual([]);
		expect(h.handle.raw).toBe(false);
		expect(h.traces).toHaveLength(1);
		expect(h.traces[0]).toContain("win32");
	});

	test("win32 with 8GENT_EARLY_RAW=1 still enters raw mode", () => {
		const h = harness({ platform: "win32", env: { "8GENT_EARLY_RAW": "1" } });
		expect(h.calls).toEqual(["raw:true"]);
		expect(h.handle.raw).toBe(true);
	});

	test("decision table", () => {
		const tty = { isTTY: true, setRawMode() {} };
		expect(earlyRawDecision(tty, "linux", {})).toBe("raw");
		expect(earlyRawDecision(tty, "linux", { "8GENT_EARLY_RAW": "0" })).toBe("off");
		expect(earlyRawDecision({ isTTY: false, setRawMode() {} }, "linux", {})).toBe("off");
		expect(earlyRawDecision(tty, "win32", {})).toBe("win32-skip");
	});
});
