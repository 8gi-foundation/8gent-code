/**
 * CommandInput - single Enter submits.
 *
 * Regression for the 2026-09-28 fault: a typed message plus one Enter was
 * not sent; a second Enter was needed. Ink hands useInput one event per
 * stdin read, so when the event loop is busy (the full TUI re-rendering)
 * the typed text and the Enter byte arrive in the SAME chunk, e.g.
 * "hello\r". ink-text-input only treats a chunk as Enter when the chunk is
 * exactly "\r", so it inserted the CR into the value instead of submitting.
 *
 * The same burst also DROPPED characters: ink-text-input computes the next
 * value from its `value` prop captured in a closure that Ink only re-binds
 * after React flushes passive effects. Reads that land before that flush
 * start from the stale value, so earlier characters vanish.
 *
 * These tests mount the real component through Ink with an in-memory
 * stdin/stdout (no ink-testing-library in the repo) and drive keystrokes
 * exactly as a terminal would deliver them.
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

describe("CommandInput Enter handling", () => {
	test("typed text then a separate Enter submits once", async () => {
		const { submitted, press } = await mount();
		await press("hello, what can you do?", "hello, what can you do?");
		await press("\r", "Type a command");
		expect(submitted).toEqual(["hello, what can you do?"]);
	});

	test("text and Enter coalesced into one stdin chunk submit on the first Enter", async () => {
		const { submitted, press } = await mount();
		await press("hello, what can you do?\r");
		await waitFor(() => submitted.length > 0, "submit").catch(() => {});
		expect(submitted).toEqual(["hello, what can you do?"]);
		// The input was cleared, so a second Enter sends nothing more.
		await press("\r");
		expect(submitted).toEqual(["hello, what can you do?"]);
	});

	test("coalesced chunk after earlier keystrokes submits the full line", async () => {
		const { submitted, press } = await mount();
		await press("h", "h");
		await press("ello\r");
		await waitFor(() => submitted.length > 0, "submit").catch(() => {});
		expect(submitted).toEqual(["hello"]);
	});

	test("a burst split across several reads keeps every character", async () => {
		const { submitted, press, frame } = await mount();
		const text = "Say hello to Rishi in one short sentence. Do not use any tools.";
		// One read per word, all before React flushes effects.
		await press(text.split(/(?<= )/));
		await waitFor(() => frame().includes(text), "full burst on screen").catch(() => {});
		await press("\r");
		expect(submitted).toEqual([text]);
	});

	test("a burst ending in Enter across several reads submits the whole line once", async () => {
		const { submitted, press } = await mount();
		await press(["hello, ", "what can ", "you do?", "\r"]);
		await waitFor(() => submitted.length > 0, "submit").catch(() => {});
		expect(submitted).toEqual(["hello, what can you do?"]);
	});

	test("Enter while a suggestion is showing submits what was typed", async () => {
		const { submitted, press } = await mount({ recentCommands: ["hello world"] });
		await press("hel", "[Tab]"); // suggestion hint is on screen
		await press("\r", "Type a command");
		expect(submitted).toEqual(["hel"]);
	});

	test("Tab still accepts a suggestion, then Enter submits it", async () => {
		const { submitted, press } = await mount({ recentCommands: ["hello world"] });
		await press("hel", "[Tab]");
		await press("\t", "hello world");
		await press("\r", "Type a command");
		expect(submitted).toEqual(["hello world"]);
	});

	test("an exact built-in slash command runs on one Enter", async () => {
		const calls: Array<[string, string[]]> = [];
		const { submitted, press } = await mount({
			onSlashCommand: (cmd, args) => calls.push([cmd, args]),
		});
		await tick(100); // slash registry loads async
		await press("/help\r");
		await waitFor(() => calls.length > 0, "slash dispatch").catch(() => {});
		expect(calls.map((c) => c[0])).toEqual(["help"]);
		expect(submitted).toEqual([]);
	});
});
