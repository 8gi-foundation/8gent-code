/**
 * The launch splash, direction B "Converge" (#3159). The maths is tested in
 * lib/intro-converge.test.ts; here the component is rendered through real Ink
 * into a fake terminal and driven with real keystrokes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { type Instance, render } from "ink";
import {
	INTRO_DONE_MS,
	INTRO_LINE,
	INTRO_NAME,
	IntroBanner,
	carriedText,
	runColour,
} from "../IntroBanner.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

class FakeStdin extends EventEmitter {
	isTTY = true;
	private queue: string[] = [];
	setRawMode() {}
	setEncoding() {}
	ref() {}
	unref() {}
	read(): string | null {
		return this.queue.shift() ?? null;
	}
	feed(chunk: string) {
		this.queue.push(chunk);
		this.emit("readable");
	}
}

function fakeStdout(cols: number, rows: number) {
	const out = new EventEmitter() as EventEmitter & {
		columns: number;
		rows: number;
		isTTY: boolean;
		frames: string[];
		write: (s: string) => boolean;
	};
	out.columns = cols;
	out.rows = rows;
	out.isTTY = false;
	out.frames = [];
	out.write = (s: string) => {
		out.frames.push(strip(s));
		return true;
	};
	return out;
}

let instance: Instance | null = null;
afterEach(() => {
	instance?.unmount();
	instance = null;
});

function mount(
	props: Partial<React.ComponentProps<typeof IntroBanner>> = {},
	cols = 100,
	rows = 32,
) {
	const stdin = new FakeStdin();
	const stdout = fakeStdout(cols, rows);
	const calls: (string | undefined)[] = [];
	instance = render(
		<IntroBanner
			sound={false}
			rich
			colour
			onDone={(c) => calls.push(c)}
			version="0.18.0"
			{...props}
		/>,
		{
			stdin: stdin as unknown as NodeJS.ReadStream,
			stdout: stdout as unknown as NodeJS.WriteStream,
			debug: true,
			patchConsole: false,
			exitOnCtrlC: false,
		},
	);
	return { stdin, stdout, calls, last: () => stdout.frames.at(-1) ?? "" };
}

describe("intro copy", () => {
	test("keys typed to skip are handed on; Enter, space and chords are not", () => {
		expect(carriedText("h", {})).toBe("h");
		expect(carriedText("/skip all", {})).toBe("/skip all");
		expect(carriedText("\r", { return: true })).toBe("");
		expect(carriedText(" ", {})).toBe("");
		expect(carriedText("a", { ctrl: true })).toBe("");
		expect(carriedText("", { escape: true })).toBe("");
	});
});

describe("the splash in a real Ink render", () => {
	test("any key skips at once, from the first frame, and hands the key on", async () => {
		const { stdin, calls } = mount();
		await tick(40);
		stdin.feed("h");
		await tick(40);
		expect(calls).toEqual(["h"]);
	});

	test("a key already waiting when the splash mounts skips it too (#3159)", async () => {
		const stdin = new FakeStdin();
		stdin.feed("x"); // pressed before the first paint
		const stdout = fakeStdout(100, 32);
		const calls: (string | undefined)[] = [];
		instance = render(<IntroBanner sound={false} rich colour onDone={(c) => calls.push(c)} />, {
			stdin: stdin as unknown as NodeJS.ReadStream,
			stdout: stdout as unknown as NodeJS.WriteStream,
			debug: true,
			patchConsole: false,
			exitOnCtrlC: false,
		});
		await tick(60);
		stdin.emit("readable");
		await tick(40);
		expect(calls).toEqual(["x"]);
	});

	test("Enter skips too, and carries nothing", async () => {
		const { stdin, calls } = mount();
		await tick(40);
		stdin.feed("\r");
		await tick(40);
		expect(calls).toEqual([""]);
	});

	test("it finishes on its own inside 1.5 s", async () => {
		const { calls } = mount({ speed: 10 });
		await tick(Math.ceil(INTRO_DONE_MS / 10) + 150);
		expect(calls.length).toBe(1);
	});

	test("the dots arrive, the mark is braille, the name and the line follow", async () => {
		const { stdout } = mount({ speed: 4 }, 160, 48);
		await tick(Math.ceil(1400 / 4));
		const all = stdout.frames.join("\n");
		expect(all).toMatch(/[\u2801-\u28ff]/);
		expect(all).not.toMatch(/[\u2580-\u259f]/);
		expect(all).toContain(INTRO_NAME);
		expect(all).toContain(INTRO_LINE);
		expect(all).toContain("any key skips");
	});

	test("reduced motion: no splash at all, the HUD at once (no 1.5 s hold)", async () => {
		const { stdout, calls } = mount({ animate: false });
		await tick(30);
		expect(calls.length).toBe(1);
		expect(stdout.frames.join("")).not.toContain(INTRO_LINE);
	});

	test("no braille (TERM=dumb, ASCII): no splash", async () => {
		const { calls } = mount({ rich: false });
		await tick(30);
		expect(calls.length).toBe(1);
	});

	test("NO_COLOR (#3158): no run gets a colour; with colour the mark is the brand ambers", async () => {
		expect(runColour("top", false)).toBeUndefined();
		expect(runColour("hot", false)).toBeUndefined();
		expect(runColour(null, true)).toBeUndefined();
		expect(runColour("top", true)).toBe("#F07A28");
		expect(runColour("bottom", true)).toBe("#E8610A");
		// And the component still draws the whole splash without colour.
		const { stdout } = mount({ colour: false, speed: 4 }, 160, 48);
		await tick(Math.ceil(1300 / 4));
		expect(stdout.frames.join("")).toContain(INTRO_NAME);
		expect(stdout.frames.join("")).toMatch(/[\u2801-\u28ff]/);
	});
});
