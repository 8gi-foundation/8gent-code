/**
 * OSC 11 terminal background probe (#3754): parses every reply form xterm
 * documents, ends early on a DA1-only answer, times out cleanly on silence,
 * never touches a non-TTY, and hands unrelated keystrokes back to stdin.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
	DA1_QUERY,
	OSC11_QUERY,
	parseOsc11Hex,
	probeTerminalBackground,
	stripReplies,
} from "../theme/terminal-probe.js";

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;

describe("parseOsc11", () => {
	test("rgb: with 4 hex digits per channel, BEL terminated", () => {
		expect(parseOsc11Hex(`${ESC}]11;rgb:0a0a/0909/0808${BEL}`)).toBe("#0a0908");
	});
	test("rgb: with ST terminator", () => {
		expect(parseOsc11Hex(`${ESC}]11;rgb:ffff/ffff/ffff${ST}`)).toBe("#ffffff");
	});
	test("rgb: with 2 and 1 hex digits per channel scales to the digit count", () => {
		expect(parseOsc11Hex(`${ESC}]11;rgb:fd/f6/e3${BEL}`)).toBe("#fdf6e3");
		expect(parseOsc11Hex(`${ESC}]11;rgb:f/0/8${BEL}`)).toBe("#ff0088");
	});
	test("rgba: ignores the alpha channel", () => {
		expect(parseOsc11Hex(`${ESC}]11;rgba:2828/2828/2828/ffff${BEL}`)).toBe("#282828");
	});
	test("finds the reply inside other bytes", () => {
		expect(parseOsc11Hex(`ab${ESC}]11;rgb:0000/2b2b/3636${BEL}${ESC}[?62;22c`)).toBe("#002b36");
	});
	test("rejects malformed and unrelated input", () => {
		expect(parseOsc11Hex("")).toBeNull();
		expect(parseOsc11Hex(`${ESC}]11;rgb:zzzz/0000/0000${BEL}`)).toBeNull();
		expect(parseOsc11Hex(`${ESC}]11;rgb:0000/0000${BEL}`)).toBeNull();
		expect(parseOsc11Hex(`${ESC}]11;rgb:0000/0000/0000`)).toBeNull(); // no terminator yet
		expect(parseOsc11Hex(`${ESC}]10;rgb:ffff/ffff/ffff${BEL}`)).toBeNull(); // OSC 10 is the foreground
		expect(parseOsc11Hex(`${ESC}]11;rgb:1/2/3/4${BEL}`)).toBeNull(); // rgb: with alpha
		expect(parseOsc11Hex(`${ESC}]11;rgba:1/2/3${BEL}`)).toBeNull(); // rgba: without alpha
	});
	test("stripReplies keeps only the bytes that are not replies", () => {
		expect(stripReplies(`q${ESC}]11;rgb:0/0/0${BEL}${ESC}[?1;2cw`)).toBe("qw");
	});
});

class FakeStdin extends EventEmitter {
	isTTY = true;
	isRaw = false;
	paused = true;
	rawCalls: boolean[] = [];
	unshifted: string[] = [];
	setRawMode(mode: boolean) {
		this.rawCalls.push(mode);
		this.isRaw = mode;
		return this;
	}
	resume() {
		this.paused = false;
		return this;
	}
	pause() {
		this.paused = true;
		return this;
	}
	unshift(chunk: Buffer | string) {
		this.unshifted.push(chunk.toString());
	}
}

function fakeStdout(onWrite?: (s: string) => void) {
	const writes: string[] = [];
	return {
		isTTY: true,
		writes,
		write(s: string) {
			writes.push(s);
			onWrite?.(s);
			return true;
		},
	};
}

// The probe's stream type is NodeJS.ReadableStream; the fake implements the
// parts it uses.
const asStdin = (s: FakeStdin) => s as unknown as NodeJS.ReadableStream & { isTTY: boolean };

describe("probeTerminalBackground", () => {
	test("reads the reply, restores line mode, and returns the hex", async () => {
		const stdin = new FakeStdin();
		const stdout = fakeStdout(() =>
			queueMicrotask(() =>
				stdin.emit("data", Buffer.from(`${ESC}]11;rgb:fdfd/f6f6/e3e3${BEL}${ESC}[?62c`)),
			),
		);
		const hex = await probeTerminalBackground({ stdin: asStdin(stdin), stdout, env: {} });
		expect(hex).toBe("#fdf6e3");
		expect(stdout.writes).toEqual([OSC11_QUERY + DA1_QUERY]);
		expect(stdin.rawCalls).toEqual([true, false]);
		expect(stdin.listenerCount("data")).toBe(0);
		expect(stdin.paused).toBe(true);
	});

	test("leaves raw mode on when it was already on (early-input)", async () => {
		const stdin = new FakeStdin();
		stdin.isRaw = true;
		const stdout = fakeStdout(() =>
			queueMicrotask(() => stdin.emit("data", `${ESC}]11;rgb:0/0/0${BEL}`)),
		);
		expect(await probeTerminalBackground({ stdin: asStdin(stdin), stdout, env: {} })).toBe(
			"#000000",
		);
		expect(stdin.rawCalls).toEqual([]);
	});

	test("a reply split across chunks still parses, and a key typed meanwhile goes back to stdin", async () => {
		const stdin = new FakeStdin();
		const stdout = fakeStdout(() =>
			queueMicrotask(() => {
				stdin.emit("data", `x${ESC}]11;rgb:28`);
				stdin.emit("data", `28/2828/2828${BEL}`);
			}),
		);
		expect(await probeTerminalBackground({ stdin: asStdin(stdin), stdout, env: {} })).toBe(
			"#282828",
		);
		expect(stdin.unshifted).toEqual(["x"]);
	});

	test("a DA1 answer with no OSC 11 answer ends the probe at once with null", async () => {
		const stdin = new FakeStdin();
		const stdout = fakeStdout(() => queueMicrotask(() => stdin.emit("data", `${ESC}[?1;2c`)));
		const started = performance.now();
		const hex = await probeTerminalBackground({
			stdin: asStdin(stdin),
			stdout,
			env: {},
			timeoutMs: 5000,
		});
		expect(hex).toBeNull();
		expect(performance.now() - started).toBeLessThan(1000);
	});

	test("silence times out cleanly with null and detaches", async () => {
		const stdin = new FakeStdin();
		const stdout = fakeStdout();
		const started = performance.now();
		const hex = await probeTerminalBackground({
			stdin: asStdin(stdin),
			stdout,
			env: {},
			timeoutMs: 40,
		});
		const took = performance.now() - started;
		expect(hex).toBeNull();
		expect(took).toBeGreaterThanOrEqual(35);
		expect(took).toBeLessThan(1000);
		expect(stdin.listenerCount("data")).toBe(0);
		expect(stdin.rawCalls).toEqual([true, false]);
	});

	test("no TTY (CI, pilot, pipe): returns null without writing a byte", async () => {
		const stdin = new FakeStdin();
		stdin.isTTY = false;
		const stdout = fakeStdout();
		expect(await probeTerminalBackground({ stdin: asStdin(stdin), stdout, env: {} })).toBeNull();
		const tty = new FakeStdin();
		const pipeOut = { ...fakeStdout(), isTTY: false };
		expect(
			await probeTerminalBackground({ stdin: asStdin(tty), stdout: pipeOut, env: {} }),
		).toBeNull();
		expect(stdout.writes).toEqual([]);
		expect(pipeOut.writes).toEqual([]);
	});

	test("EIGHT_OSC11=0 opts out", async () => {
		const stdin = new FakeStdin();
		const stdout = fakeStdout();
		expect(
			await probeTerminalBackground({ stdin: asStdin(stdin), stdout, env: { EIGHT_OSC11: "0" } }),
		).toBeNull();
		expect(stdout.writes).toEqual([]);
	});
});
