/**
 * Plain PgUp/PgDn in the chat: they scroll the conversation in every layout
 * (pilot break 9: on a laptop PgDn did nothing, since plain paging was
 * keys-up only), and never while an approval card is pending, because the card
 * pages itself with the same keys.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { type Instance, render } from "ink";
import React from "react";
import type { Message } from "../../app.js";
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
const PAGE_UP = "\u001B[5~";

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
});

async function pageUpOnce(props: { touchHints?: boolean; approvalPending?: boolean }) {
	const stdin = new FakeStdin();
	const stdout = makeStdout();
	instance = render(
		<MessageList
			messages={messages}
			animateTyping={false}
			showAnimations={false}
			turnRunning={false}
			rowBudget={8}
			contentWidth={44}
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
	await tick(120);
	const before = stripAnsi(stdout.last);
	stdin.feed(PAGE_UP);
	await tick(120);
	const after = stripAnsi(stdout.last);
	return { before, after };
}

describe("MessageList plain PgUp", () => {
	test("keys-up: plain PgUp scrolls the chat back", async () => {
		const { before, after } = await pageUpOnce({ touchHints: true });
		expect(before).toContain("line-40");
		expect(after).not.toBe(before);
		expect(after).not.toContain("line-40");
	});

	test("keys-up with an approval card pending: PgUp leaves the chat where it is", async () => {
		const { before, after } = await pageUpOnce({ touchHints: true, approvalPending: true });
		expect(before).toContain("line-40");
		expect(after).toBe(before);
	});

	test("roomy: plain PgUp scrolls the chat back too", async () => {
		const { before, after } = await pageUpOnce({ touchHints: false });
		expect(before).toContain("line-40");
		expect(after).not.toBe(before);
		expect(after).not.toContain("line-40");
	});
});
