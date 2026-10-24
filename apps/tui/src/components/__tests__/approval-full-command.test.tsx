/**
 * The approval card shows the whole command before a yes (#4928 pass, 8DO).
 * The compact card used to cut the command with an ellipsis ("rm -rf node_module…")
 * while asking the person to approve it. Now a command that does not fit one
 * row is shown wrapped, in full; one taller than the screen scrolls, and a
 * yes is not taken until its last line has been on screen. Phone widths too.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { Box, type Instance, render, useInput } from "ink";
import React from "react";

import {
	_resetTuiApprovalChannel,
	requestTuiApproval,
} from "../../../../../packages/permissions/tui-approval-channel.js";
import {
	_resetApprovalCard,
	isApprovalKeyClaimed,
	useApprovalCard,
} from "../../hooks/useApprovalCard.js";
import { InlineApprovalPrompt } from "../InlineApprovalPrompt.js";

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
	feed(...chunks: string[]) {
		this.queue.push(...chunks);
		this.emit("readable");
	}
}

type FakeStdout = Writable & { columns: number; rows: number; written: string; last: string };

function makeStdout(columns = 100, rows = 30): FakeStdout {
	const out = new Writable({
		write(chunk, _enc, cb) {
			const s = chunk.toString();
			out.written += s;
			if (s.trim()) out.last = s;
			cb();
		},
	}) as FakeStdout;
	out.written = "";
	out.last = "";
	out.columns = columns;
	out.rows = rows;
	return out;
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const stripAnsi = (s: string) => s.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");

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
	_resetTuiApprovalChannel();
	_resetApprovalCard();
});

import { CARD_MIN_SHOW_MS } from "../../hooks/useApprovalCard.js";

/** The app's wiring: the card gets what app.tsx passes it (target, reason, full, gate). */
function Harness({ innerWidth }: { innerWidth?: number }) {
	const approvalPending = useApprovalCard();
	useInput((input, key) => {
		if (isApprovalKeyClaimed(input, key)) return;
	});
	return (
		<Box flexDirection="column" width={innerWidth}>
			{approvalPending && (
				<InlineApprovalPrompt
					target={approvalPending.target}
					reason={approvalPending.reason}
					full={approvalPending.full}
					gate={approvalPending.gate}
				/>
			)}
		</Box>
	);
}

async function mount(columns: number, rows = 40, innerWidth?: number) {
	const stdin = new FakeStdin();
	const stdout = makeStdout(columns, rows);
	instance = render(<Harness innerWidth={innerWidth} />, {
		stdin: stdin as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: makeStdout(columns, rows) as unknown as NodeJS.WriteStream,
		debug: false,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	const frame = () => stripAnsi(stdout.last);
	const ask = (command: string) =>
		requestTuiApproval({ action: "Execute Shell Command", details: "", command });
	return { stdin, frame, ask };
}

/** What the card shows of the command: border and padding gone, every space gone. */
const body = (frame: string) =>
	frame
		.split("\n")
		.filter((l) => !/^[\s╭╰─╮╯]*$/.test(l))
		.map((l) => l.replace(/^\s*│/, "").replace(/│\s*$/, ""))
		.join("")
		.replace(/\s+/g, "");
const squash = (s: string) => s.replace(/\s+/g, "");

/** 300 characters: words, a path, flags and one long unbroken token. */
const LONG_300 =
	`${"rm -rf ./build ./dist ./.cache && curl -fsSL https://example.com/install.sh -o /tmp/i.sh && sh /tmp/i.sh --prefix=/usr/local ".repeat(2)}${"X".repeat(60)}`.slice(
		0,
		300,
	);

for (const columns of [52, 80]) {
	describe(`approval card at ${columns} columns`, () => {
		test("a 300 character command shows every character, wrapped and never cut", async () => {
			expect(LONG_300.length).toBe(300);
			const { frame, ask } = await mount(columns);
			void ask(LONG_300);
			await waitFor(() => frame().includes("[Y] approve"), "card shown");
			await tick(60);
			expect(body(frame())).toContain(squash(LONG_300));
			expect(frame()).not.toContain("…");
		});

		test("a short command stays one row", async () => {
			const { frame, ask } = await mount(columns);
			void ask("cd src");
			await waitFor(() => frame().includes("[Y] approve"), "card shown");
			// Wide enough for one row: one line. A phone gives it the full card; either way it is whole.
			if (columns >= 80)
				expect(
					frame()
						.split("\n")
						.filter((l) => l.includes("cd src")).length,
				).toBe(1);
			expect(frame()).toContain("cd src");
			expect(frame()).not.toContain("…");
		});

		test("a yes before the end of a very long command has been shown does nothing", async () => {
			const long = Array.from({ length: 80 }, (_, i) => `step${i}=${"a".repeat(30)}`).join(" ");
			const { stdin, frame, ask } = await mount(columns, 24);
			let decided = null as boolean | null;
			void ask(long).then((d) => {
				decided = d;
			});
			await waitFor(() => frame().includes("[Y] approve"), "card shown");
			expect(body(frame())).not.toContain(squash(long));
			await tick(CARD_MIN_SHOW_MS + 100);
			stdin.feed("y");
			await tick(150);
			expect(decided).toBeNull();
			expect(frame()).toContain("[Y] approve");
			// Scroll to the end: the last words appear, then a yes is taken.
			for (let i = 0; i < 400 && !body(frame()).includes(squash(long).slice(-40)); i++) {
				stdin.feed("\x1b[B");
				await tick(8);
			}
			expect(body(frame())).toContain(squash(long).slice(-40));
			await tick(CARD_MIN_SHOW_MS + 100);
			stdin.feed("y");
			await waitFor(() => decided !== null, "decision");
			expect(decided).toBe(true);
		});

		test("n and s answer at any point, even before the end", async () => {
			const long = Array.from({ length: 80 }, (_, i) => `step${i}=${"b".repeat(30)}`).join(" ");
			const { stdin, frame, ask } = await mount(columns, 24);
			const decision = ask(long);
			await waitFor(() => frame().includes("[Y] approve"), "card shown");
			await tick(CARD_MIN_SHOW_MS + 100);
			stdin.feed("n");
			expect(await decision).toBe(false);
		});
	});
}

describe("approval card in a column narrower than the screen (beside the rail or plan)", () => {
	test("wraps at the card's own width: every character, none cut", async () => {
		const { frame, ask } = await mount(120, 40, 50);
		void ask(LONG_300);
		await waitFor(() => frame().includes("[Y] approve"), "card shown");
		await tick(120);
		expect(body(frame())).toContain(squash(LONG_300));
		expect(frame()).not.toContain("…");
	});
});
