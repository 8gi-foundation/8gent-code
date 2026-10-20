import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { WATCHDOG_MS, armEarlyInput, earlyRawDecision } from "./early-input.js";

function harness(over: { platform?: string; env?: Record<string, string | undefined> } = {}) {
	const calls: string[] = [];
	const traces: string[] = [];
	let fire: (() => void) | null = null;
	let cleared = false;
	// A real stream: bytes written to it must survive the watchdog.
	const stdin = Object.assign(new PassThrough(), {
		isTTY: true,
		isRaw: false,
		setRawMode(m: boolean) {
			calls.push(`raw:${m}`);
			stdin.isRaw = m;
		},
	});
	const origResume = stdin.resume.bind(stdin);
	stdin.resume = () => {
		calls.push("resume");
		return origResume();
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
	return { stdin, calls, traces, handle, fire: () => fire?.(), cleared: () => cleared };
}

describe("early raw-mode watchdog (#4540)", () => {
	test("fires when Ink never mounts: raw off, one trace line, never resumed", () => {
		const h = harness();
		expect(h.calls).toEqual(["raw:true"]);
		h.fire();
		expect(h.calls).toEqual(["raw:true", "raw:false"]);
		expect(h.traces).toHaveLength(1);
		expect(h.traces[0]).toContain("watchdog");
	});

	test("typed bytes survive the watchdog: still buffered and readable", () => {
		const h = harness();
		h.stdin.write("hi");
		h.fire();
		expect(h.calls).not.toContain("resume");
		expect(h.stdin.read()?.toString()).toBe("hi");
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
