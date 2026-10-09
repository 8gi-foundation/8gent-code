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
	ReplyFilter,
	installLateReplyFilter,
	parseOsc11Hex,
	probeTerminalBackground,
	splitTrailingPartial,
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

describe("late and split replies never reach the prompt", () => {
	test("splitTrailingPartial holds an unterminated OSC or DA1 reply, never a lone Esc or an arrow key", () => {
		expect(splitTrailingPartial(`ab${ESC}]11;rgb:28`)).toEqual(["ab", `${ESC}]11;rgb:28`]);
		expect(splitTrailingPartial(`ab${ESC}]11;rgb:0/0/0${ESC}`)).toEqual([
			"ab",
			`${ESC}]11;rgb:0/0/0${ESC}`,
		]);
		expect(splitTrailingPartial(`ab${ESC}[?62;2`)).toEqual(["ab", `${ESC}[?62;2`]);
		expect(splitTrailingPartial(`ab${ESC}`)).toEqual([`ab${ESC}`, ""]);
		expect(splitTrailingPartial(`ab${ESC}[A`)).toEqual([`ab${ESC}[A`, ""]);
	});

	test("ReplyFilter strips a reply split across three chunks and passes the keys around it", () => {
		const f = new ReplyFilter();
		expect(f.push(`h${ESC}]11;rg`)).toBe("h");
		expect(f.push("b:2828/2828/")).toBe("");
		expect(f.push(`2828${ST}i${ESC}[?6`)).toBe("i");
		expect(f.push("2;22c!")).toBe("!");
		expect(f.pending).toBe("");
	});

	/** A stdin whose read() hands out queued chunks, like a paused tty. */
	function queuedStdin(chunks: Array<Buffer | string>) {
		return {
			read: (_size?: number) => (chunks.length ? (chunks.shift() as Buffer | string) : null),
		};
	}
	function drain(s: { read?: (n?: number) => unknown }): string {
		let out = "";
		for (let v = s.read?.(); v !== null && v !== undefined; v = s.read?.()) out += v.toString();
		return out;
	}

	test("a reply arriving after the probe is stripped from what Ink reads", () => {
		const s = queuedStdin([
			Buffer.from(`${ESC}]11;rgb:ffff/ffff/ffff${BEL}`),
			Buffer.from(`${ESC}[?1;2c`),
			Buffer.from("y"),
		]);
		installLateReplyFilter(s, "", 1000);
		expect(drain(s)).toBe("y");
	});

	test("a partial left over from the probe is completed and dropped, not delivered", () => {
		const s = queuedStdin([Buffer.from(`fff/ffff${BEL}`), Buffer.from("k")]);
		installLateReplyFilter(s, `${ESC}]11;rgb:ffff/`, 1000);
		expect(drain(s)).toBe("k");
	});

	test("a partial still held when the window closes is dropped, never put back", () => {
		let clock = 0;
		const queue: Array<Buffer | string> = [Buffer.from(`${ESC}]11;rgb:00`)];
		const s = queuedStdin(queue);
		installLateReplyFilter(s, "", 100, () => clock);
		expect(drain(s)).toBe("");
		clock = 500;
		queue.push(Buffer.from("z"));
		expect(drain(s)).toBe("z");
	});

	test("a multi-byte key split across reads survives the filter", () => {
		const eacute = Buffer.from("\u00e9");
		const s = queuedStdin([eacute.subarray(0, 1), eacute.subarray(1)]);
		installLateReplyFilter(s, "", 1000);
		expect(drain(s)).toBe("\u00e9");
	});

	test("the probe never unshifts a partial reply, only the keys around it", async () => {
		const stdin = new FakeStdin();
		const stdout = fakeStdout(() => queueMicrotask(() => stdin.emit("data", `q${ESC}]11;rgb:28`)));
		const hex = await probeTerminalBackground({
			stdin: asStdin(stdin),
			stdout,
			env: {},
			timeoutMs: 30,
		});
		expect(hex).toBeNull();
		expect(stdin.unshifted).toEqual(["q"]);
	});

	test("a multi-byte key typed during the probe is decoded whole", async () => {
		const stdin = new FakeStdin();
		const bytes = Buffer.from("\u00e9");
		const stdout = fakeStdout(() =>
			queueMicrotask(() => {
				stdin.emit("data", bytes.subarray(0, 1));
				stdin.emit(
					"data",
					Buffer.concat([bytes.subarray(1), Buffer.from(`${ESC}]11;rgb:0/0/0${BEL}`)]),
				);
			}),
		);
		expect(await probeTerminalBackground({ stdin: asStdin(stdin), stdout, env: {} })).toBe(
			"#000000",
		);
		expect(stdin.unshifted).toEqual(["\u00e9"]);
	});
});
