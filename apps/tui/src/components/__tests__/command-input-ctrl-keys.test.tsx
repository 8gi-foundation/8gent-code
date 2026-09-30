/**
 * CommandInput - Ctrl+letter shortcuts never type their letter (#3166).
 *
 * Regression for the 2026-09-30 fault: Ctrl+P then Esc left a stray "p" in
 * the chat input. Ink reports Ctrl+P as input "p" with key.ctrl set, and it
 * hands that one keypress to every active useInput handler. The app handler
 * opened the palette; the chat input's own handler typed "p" in the same
 * keypress. The input is hidden while the palette is open, so the "p" showed
 * on close. Every Ctrl+letter the app binds (K, O, X, Y, ...) leaked the same
 * way while the chat input had focus.
 *
 * These tests mount the real component through Ink with an in-memory
 * stdin/stdout and write the exact control bytes a terminal sends.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { type Instance, render } from "ink";
import type React from "react";

import { CommandInput } from "../command-input.js";

/**
 * A TTY-shaped stdin that hands Ink one queued chunk per read(). Ink drains
 * every available chunk in a single "readable" callback, which is how a
 * terminal burst reaches a busy process: several reads land before React has
 * flushed the effects that re-bind input handlers to the latest value.
 */
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
	/** Deliver one or more chunks in a single readable event. */
	feed(...chunks: string[]) {
		this.queue.push(...chunks);
		this.emit("readable");
	}
}

type FakeStdout = Writable & { columns: number; rows: number; written: string };

function makeStdout(): FakeStdout {
	const out = new Writable({
		write(chunk, _enc, cb) {
			out.written += chunk.toString();
			cb();
		},
	}) as FakeStdout;
	out.written = "";
	out.columns = 100;
	out.rows = 30;
	return out;
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const stripAnsi = (s: string) => s.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");

/** Poll until `check` passes, so tests key off renders, not wall-clock guesses. */
async function waitFor(check: () => boolean, label: string, timeoutMs = 3000) {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await tick(10);
	}
}

let instance: Instance | null = null;

afterEach(() => {
	instance?.unmount();
	instance = null;
});

async function mount(props: Partial<React.ComponentProps<typeof CommandInput>> = {}) {
	const submitted: string[] = [];
	const stdin = new FakeStdin();
	const stdout = makeStdout();
	instance = render(
		<CommandInput
			onSubmit={(v) => submitted.push(v)}
			isProcessing={false}
			showAnimations={false}
			{...props}
		/>,
		{
			stdin: stdin as unknown as NodeJS.ReadStream,
			stdout: stdout as unknown as NodeJS.WriteStream,
			stderr: makeStdout() as unknown as NodeJS.WriteStream,
			debug: false,
			exitOnCtrlC: false,
			patchConsole: false,
		},
	);
	await waitFor(() => stripAnsi(stdout.written).includes("Type a command"), "first frame");
	const frame = () => stripAnsi(stdout.written);
	/** Write raw bytes to stdin, then wait until the frame shows `expect`. */
	const press = async (data: string | string[], expect?: string) => {
		const mark = stdout.written.length;
		stdin.feed(...(Array.isArray(data) ? data : [data]));
		if (expect !== undefined) {
			await waitFor(() => stripAnsi(stdout.written.slice(mark)).includes(expect), expect);
			await tick(20); // let post-commit effects re-bind input handlers
		} else {
			await tick(50);
		}
	};
	return { submitted, press, frame };
}

/** Ctrl+letter bytes for every shortcut the app binds while the chat input has focus. */
const CTRL_SHORTCUTS: Array<[string, string]> = [
	["a", "\x01"], // animations
	["b", "\x02"], // process panel
	["d", "\x04"], // DjDeck
	["e", "\x05"], // predict
	["g", "\x07"], // background task
	["k", "\x0b"], // kanban
	["l", "\x0c"], // bubble nav
	["n", "\x0e"], // notes
	["o", "\x0f"], // expanded view
	["p", "\x10"], // command palette
	["s", "\x13"], // sound
	["t", "\x14"], // new tab
	["w", "\x17"], // close tab
	["x", "\x18"], // plan column
	["y", "\x19"], // agent mode
];

describe("CommandInput Ctrl+letter shortcuts", () => {
	test("Ctrl+P then Esc leaves the input as it was (#3166)", async () => {
		const { submitted, press } = await mount();
		await press("hi", "hi");
		await press("\x10"); // Ctrl+P, as the terminal sends it
		await press("\x1b"); // Esc
		await press("\r");
		await waitFor(() => submitted.length > 0, "submit").catch(() => {});
		expect(submitted).toEqual(["hi"]);
	});

	for (const [letter, byte] of CTRL_SHORTCUTS) {
		test(`Ctrl+${letter.toUpperCase()} does not type "${letter}"`, async () => {
			const { submitted, press } = await mount();
			await press("hi", "hi");
			await press(byte);
			await press("\r");
			await waitFor(() => submitted.length > 0, "submit").catch(() => {});
			expect(submitted).toEqual(["hi"]);
		});
	}

	test("plain letters, backspace and arrows still edit the line", async () => {
		const { submitted, press } = await mount();
		await press("hipx", "hipx");
		await press("\x7f"); // Backspace
		await press("\x1b[D"); // Left
		await press("o");
		await press("\r");
		await waitFor(() => submitted.length > 0, "submit").catch(() => {});
		expect(submitted).toEqual(["hiop"]);
	});
});
