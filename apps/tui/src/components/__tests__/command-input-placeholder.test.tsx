/**
 * CommandInput while a task runs: the placeholder says what happens to what
 * the person types, in a wide and a narrow form, and the cursor block sits on
 * its own cell before the text instead of covering the first letter.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { type Instance, render } from "ink";

import {
	BUSY_PLACEHOLDER_NARROW_COLUMNS,
	CommandInput,
	STEER_PLACEHOLDER,
	STEER_PLACEHOLDER_NARROW,
	busyPlaceholder,
} from "../command-input.js";

class FakeStdin extends EventEmitter {
	isTTY = true;
	setRawMode() {}
	setEncoding() {}
	ref() {}
	unref() {}
	read(): string | null {
		return null;
	}
}

function makeStdout(columns: number) {
	const out = new Writable({
		write(chunk, _enc, cb) {
			out.written += chunk.toString();
			cb();
		},
	}) as Writable & { columns: number; rows: number; written: string };
	out.written = "";
	out.columns = columns;
	out.rows = 30;
	return out;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const stripAnsi = (s: string) => s.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");

let instance: Instance | null = null;
afterEach(() => {
	instance?.unmount();
	instance = null;
});

async function frameAt(columns: number): Promise<string> {
	const stdout = makeStdout(columns);
	instance = render(
		<CommandInput onSubmit={() => {}} isProcessing={true} showAnimations={false} />,
		{
			stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
			stdout: stdout as unknown as NodeJS.WriteStream,
			stderr: makeStdout(columns) as unknown as NodeJS.WriteStream,
			debug: false,
			exitOnCtrlC: false,
			patchConsole: false,
		},
	);
	const start = Date.now();
	while (!stripAnsi(stdout.written).includes("Enter steers")) {
		if (Date.now() - start > 3000) throw new Error("no placeholder frame");
		await new Promise((r) => setTimeout(r, 10));
	}
	instance.unmount();
	instance = null;
	return stripAnsi(stdout.written);
}

describe("busy placeholder", () => {
	test("picks the short form under 60 columns, the full one from 60", () => {
		expect(BUSY_PLACEHOLDER_NARROW_COLUMNS).toBe(60);
		expect(busyPlaceholder(59)).toBe("Enter steers. Alt+Enter queues.");
		expect(busyPlaceholder(60)).toBe(
			"Enter steers. Alt+Enter queues a follow-up for after this task.",
		);
		expect(STEER_PLACEHOLDER.length).toBeLessThanOrEqual(78);
	});

	test("wide frame shows the full text with the cursor cell before the E", async () => {
		const frame = await frameAt(100);
		expect(frame).toContain(STEER_PLACEHOLDER);
		// chevron, a space, the cursor cell, then the whole first word
		expect(frame).toMatch(/\S {2}Enter steers\./);
	});

	test("narrow frame shows the short text with the cursor cell before the E", async () => {
		const frame = await frameAt(50);
		expect(frame).toContain(STEER_PLACEHOLDER_NARROW);
		expect(frame).not.toContain("for after this task");
		expect(frame).toMatch(/\S {2}Enter steers\./);
	});
});
