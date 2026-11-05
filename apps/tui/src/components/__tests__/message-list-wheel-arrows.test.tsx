/**
 * The wheel in select mode (#5094): the terminal sends arrow keys, the mouse
 * layer turns a burst into wheel events, and the real MessageList scrolls.
 * A lone arrow is left for the input's history and moves nothing here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { type Instance, render } from "ink";
import React from "react";
import type { Message } from "../../app.js";
import { _disposeMouse, installMouse, setWheelInputEmpty } from "../../lib/mouse-input.js";
import { MessageList } from "../message-list.js";

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

function makeStdout(columns = 52) {
	const out = new Writable({
		write(chunk, _enc, cb) {
			const s = chunk.toString();
			out.written += s;
			if (s.trim()) out.last = s;
			cb();
		},
	}) as Writable & { columns: number; rows: number; written: string; last: string };
	out.written = "";
	out.last = "";
	out.columns = columns;
	out.rows = 20;
	return out;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const stripAnsi = (s: string) => s.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/** Wait until the frame satisfies `done`, up to `ms`: a fixed sleep flakes on a loaded machine. */
async function until(frame: () => string, done: (s: string) => boolean, ms = 4000) {
	const end = Date.now() + ms;
	while (Date.now() < end && !done(stripAnsi(frame()))) await tick(20);
}
const UP = "\u001B[A";

const messages: Message[] = Array.from({ length: 40 }, (_, i) => ({
	id: `m${i + 1}`,
	role: "assistant" as const,
	content: `line-${i + 1}`,
	timestamp: new Date("2026-10-24T15:00:00Z"),
}));

let instance: Instance | null = null;
afterEach(() => {
	instance?.unmount();
	instance = null;
	_disposeMouse();
	setWheelInputEmpty(true);
});

async function feedArrows(chunk: string, settled?: (frame: string) => boolean) {
	const stdin = new FakeStdin();
	const stdout = makeStdout();
	const mouseOut = { write: (_s: string) => true };
	installMouse(stdin as unknown as NodeJS.ReadStream, mouseOut, {
		mode: "select",
		processHooks: false,
	});
	instance = render(
		<MessageList
			messages={messages}
			animateTyping={false}
			showAnimations={false}
			turnRunning={false}
			rowBudget={8}
			contentWidth={44}
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
	await until(() => stdout.last, (f) => f.includes("line-40"));
	const before = stripAnsi(stdout.last);
	stdin.feed(chunk);
	await tick(120);
	// Tests that expect a scroll say what the scrolled frame looks like and wait for it.
	if (settled) await until(() => stdout.last, settled);
	return { before, after: stripAnsi(stdout.last) };
}

describe("MessageList wheel as arrows", () => {
	test("a burst of up arrows scrolls the chat back", async () => {
		const { before, after } = await feedArrows(UP.repeat(6), (f) => !f.includes("line-40"));
		expect(before).toContain("line-40");
		expect(after).not.toContain("line-40");
	});

	test("a lone arrow does not scroll: it is the input's history key", async () => {
		const { before, after } = await feedArrows(UP);
		expect(before).toContain("line-40");
		expect(after).toBe(before);
	});

	test("a burst while a draft is typed does not scroll", async () => {
		setWheelInputEmpty(false);
		const { before, after } = await feedArrows(UP.repeat(6));
		expect(after).toBe(before);
	});
});
