/**
 * Pilot breaks 8 and 9, on the real MessageList: after paging up, sending a
 * message returns the view to the live edge; and PgDn pages back down.
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
			if (s.trim()) out.last = s;
			cb();
		},
	}) as Writable & { columns: number; rows: number; last: string };
	out.last = "";
	out.columns = columns;
	out.rows = 20;
	return out;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const stripAnsi = (s: string) => s.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");
const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const PAGE_UP = "\u001B[5~";
const PAGE_DOWN = "\u001B[6~";

const base: Message[] = Array.from({ length: 40 }, (_, i) => ({
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

function mount() {
	const stdin = new FakeStdin();
	const stdout = makeStdout();
	const el = (messages: Message[], snapSeq = 0) => (
		<MessageList
			messages={messages}
			animateTyping={false}
			showAnimations={false}
			turnRunning={false}
			rowBudget={8}
			contentWidth={44}
			snapSeq={snapSeq}
		/>
	);
	instance = render(el(base), {
		stdin: stdin as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: makeStdout() as unknown as NodeJS.WriteStream,
		debug: false,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	const frame = () => stripAnsi(stdout.last);
	return {
		stdin,
		frame,
		el,
		rerender: (m: Message[], snapSeq = 0) => instance?.rerender(el(m, snapSeq)),
	};
}

describe("MessageList scroll position", () => {
	test("PgDn pages back down after PgUp (break 9)", async () => {
		const m = mount();
		await tick();
		expect(m.frame()).toContain("line-40");
		m.stdin.feed(PAGE_UP);
		await tick();
		expect(m.frame()).not.toContain("line-40");
		m.stdin.feed(PAGE_DOWN);
		await tick();
		expect(m.frame()).toContain("line-40");
	});

	test("sending a message after paging up snaps to the bottom (break 8)", async () => {
		const m = mount();
		await tick();
		m.stdin.feed(PAGE_UP);
		await tick();
		expect(m.frame()).not.toContain("line-40");
		m.rerender([
			...base,
			{ id: "u1", role: "user", content: "my new prompt", timestamp: new Date() },
		]);
		await tick();
		expect(m.frame()).toContain("my new prompt");
	});

	test("a reply while scrolled up does not move the view", async () => {
		const m = mount();
		await tick();
		m.stdin.feed(PAGE_UP);
		await tick();
		m.rerender([
			...base,
			{ id: "a1", role: "assistant", content: "late reply", timestamp: new Date() },
		]);
		await tick();
		expect(m.frame()).not.toContain("late reply");
	});

	test("a slash command adds no message, but a submit still snaps (design fix)", async () => {
		const m = mount();
		await tick();
		m.stdin.feed(PAGE_UP);
		await tick();
		expect(m.frame()).not.toContain("line-40");
		// Same messages, snapSeq bumped by the submit path: the view returns to the edge.
		m.rerender(base, 1);
		await tick();
		expect(m.frame()).toContain("line-40");
	});

	test("hints name PgUp and PgDn in the roomy layout (design fix)", async () => {
		const m = mount();
		await tick();
		m.stdin.feed(PAGE_UP);
		await tick();
		expect(m.frame()).toContain("PgDn to follow");
		expect(m.frame()).not.toContain("shift+");
	});

	test("paging over one tall message leaves no blank window (design fix)", async () => {
		const tall: Message[] = [
			...Array.from({ length: 6 }, (_, i) => ({
				id: `s${i}`,
				role: "assistant" as const,
				content: `short-${i}`,
				timestamp: new Date("2026-10-24T15:00:00Z"),
			})),
			{
				id: "tall",
				role: "assistant" as const,
				content: Array.from({ length: 44 }, (_, i) => `tall-${i}`).join("\n"),
				timestamp: new Date("2026-10-24T15:00:00Z"),
			},
			{ id: "end", role: "assistant" as const, content: "the-end", timestamp: new Date() },
		];
		const stdin = new FakeStdin();
		const stdout = makeStdout();
		instance = render(
			<MessageList
				messages={tall}
				animateTyping={false}
				showAnimations={false}
				turnRunning={false}
				rowBudget={20}
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
		await tick();
		stdin.feed(PAGE_UP);
		await tick();
		const lines = stripAnsi(stdout.last).split("\n");
		const filled = lines.filter((l) => /(short|tall)-\d+/.test(l)).length;
		// Most of the 20-row window shows text, not blank rows.
		expect(filled).toBeGreaterThanOrEqual(10);
	});
});
