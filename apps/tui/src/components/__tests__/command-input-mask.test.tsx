/**
 * CommandInput maskInput: a key pasted at the setup prompt is never drawn.
 * The frame shows the placeholder only, before, during and after the paste,
 * and the typed value still reaches onSubmit.
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
	await waitFor(() => stripAnsi(stdout.written).includes("Key (hidden)"), "first frame");
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

const SECRET = "mm-secret-0123456789abcdef";

describe("CommandInput maskInput", () => {
	test("the typed value never appears in any frame, and is submitted whole", async () => {
		const { submitted, press, frame } = await mount({
			maskInput: true,
			placeholder: "Key (hidden)",
		});
		await press(SECRET.slice(0, 8));
		await press(SECRET.slice(8));
		expect(frame()).not.toContain(SECRET.slice(0, 8));
		expect(frame()).not.toContain(SECRET);
		await press("\r");
		expect(submitted).toEqual([SECRET]);
		expect(frame()).not.toContain(SECRET);
		expect(frame()).not.toContain("mm-secret");
	});

	test("a key that begins with a slash is an answer, not a command", async () => {
		const { submitted, press, frame } = await mount({
			maskInput: true,
			placeholder: "Key (hidden)",
		});
		await press("/not-a-command-0123456789");
		await press("\r");
		expect(submitted).toEqual(["/not-a-command-0123456789"]);
		expect(frame()).not.toContain("Unknown command");
	});
});
