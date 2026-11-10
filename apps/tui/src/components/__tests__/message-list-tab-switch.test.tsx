/**
 * Switching chat tabs: each tab shows its own history, at its own scroll
 * position, and nothing from another tab. The real MessageList is rerendered
 * the way the app does it: same element, new `messages` (and tabId).
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

const msg = (id: string, content: string, role: Message["role"] = "assistant"): Message => ({
	id,
	role,
	content,
	timestamp: new Date("2026-10-24T15:00:00Z"),
});
const many = (prefix: string, n: number) =>
	Array.from({ length: n }, (_, i) => msg(`${prefix}${i + 1}`, `${prefix}-line-${i + 1}`));

let instance: Instance | null = null;
afterEach(() => {
	instance?.unmount();
	instance = null;
});

function mount(first: Message[], tabId = "t1", rowBudget = 24) {
	const stdin = new FakeStdin();
	const stdout = makeStdout();
	const el = (messages: Message[], id: string, turnRunning = false) => (
		<MessageList
			messages={messages}
			tabId={id}
			animateTyping={false}
			showAnimations={false}
			turnRunning={turnRunning}
			rowBudget={rowBudget}
			contentWidth={44}
		/>
	);
	instance = render(el(first, tabId), {
		stdin: stdin as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: makeStdout() as unknown as NodeJS.WriteStream,
		debug: false,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	return {
		stdin,
		frame: () => stripAnsi(stdout.last),
		show: async (messages: Message[], id: string, turnRunning = false) => {
			instance?.rerender(el(messages, id, turnRunning));
			await tick();
		},
	};
}

describe("MessageList across tab switches", () => {
	test("tab 1 shows its three messages after a round trip through tab 2", async () => {
		const tab1 = [msg("a1", "alpha one", "user"), msg("a2", "alpha two"), msg("a3", "alpha three")];
		const tab2 = [msg("w2", "new thread two"), msg("b1", "beta one", "user")];
		const m = mount(tab1);
		await tick();
		expect(m.frame()).toContain("alpha three");
		await m.show(tab2, "t2");
		expect(m.frame()).toContain("beta one");
		expect(m.frame()).not.toContain("alpha");
		await m.show([...tab2, msg("b2", "beta two")], "t2");
		await m.show(tab1, "t1");
		const f = m.frame();
		expect(f).toContain("alpha one");
		expect(f).toContain("alpha two");
		expect(f).toContain("alpha three");
		expect(f).not.toContain("beta");
	});

	test("a tab keeps the scroll position it had, and a fresh tab opens at the bottom", async () => {
		const tab1 = many("a", 40);
		const tab2 = many("b", 40);
		const m = mount(tab1, "t1", 8);
		await tick();
		m.stdin.feed(PAGE_UP);
		await tick();
		expect(m.frame()).not.toContain("a-line-40");
		const scrolledFrame = m.frame();
		await m.show(tab2, "t2");
		expect(m.frame()).toContain("b-line-40");
		expect(m.frame()).not.toContain("a-line");
		await m.show(tab1, "t1");
		expect(m.frame()).toBe(scrolledFrame);
		await m.show(tab2, "t2");
		expect(m.frame()).toContain("b-line-40");
	});

	test("ten round trips do not duplicate or drop rows", async () => {
		const tab1 = [msg("a1", "alpha one", "user"), msg("a2", "alpha two"), msg("a3", "alpha three")];
		const tab2 = [msg("b1", "beta one", "user"), msg("b2", "beta two")];
		const m = mount(tab1);
		await tick();
		const count = (f: string, s: string) => f.split(s).length - 1;
		for (let i = 0; i < 10; i++) {
			await m.show(tab2, "t2");
			expect(count(m.frame(), "beta one")).toBe(1);
			expect(m.frame()).not.toContain("alpha");
			await m.show(tab1, "t1");
			for (const s of ["alpha one", "alpha two", "alpha three"])
				expect(count(m.frame(), s)).toBe(1);
			expect(m.frame()).not.toContain("beta");
		}
	});

	test("a turn streaming in tab 1 while away is complete on return", async () => {
		const early = [msg("a1", "question", "user"), msg("a2", "partial reply")];
		const m = mount(early);
		await tick();
		await m.show([msg("b1", "beta one", "user")], "t2");
		const finished = [
			msg("a1", "question", "user"),
			msg("a2", "partial reply plus the rest"),
			msg("a3", "arrived while away"),
		];
		await m.show(finished, "t1", false);
		const f = m.frame();
		expect(f).toContain("partial reply plus the rest");
		expect(f).toContain("arrived while away");
		expect(f).not.toContain("beta");
	});
});
