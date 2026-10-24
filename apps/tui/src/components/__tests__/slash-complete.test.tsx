/**
 * Slash commands complete without Tab (#4934). Artale on a phone: "the command
 * don't auto complete, i had to use tab". Typing / already opens a narrowing
 * list; now Enter on a prefix that names one command runs it, an ambiguous
 * prefix keeps the list and runs nothing, Up/Down plus Enter pick a row, and
 * every row is a tap target (#4922). Driven through the real CommandInput.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { Box, type Instance, render, useInput } from "ink";
import React from "react";

import { clearTargets, handleMouse, hitTest } from "../../lib/click-targets.js";
import { type MouseEvent, parseSgr } from "../../lib/mouse-input.js";
import { CommandInput, pickedDescription } from "../command-input.js";

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
	clearTargets();
});

const frameText = (s: FakeStdout) => stripAnsi(s.last);

async function mount(columns = 100, recent: string[] = []) {
	const calls: { name: string; args: string[] }[] = [];
	const submitted: string[] = [];
	const stdin = new FakeStdin();
	const stdout = makeStdout(columns, 40);
	instance = render(
		<CommandInput
			onSubmit={(v) => submitted.push(v)}
			onSlashCommand={(name, args) => calls.push({ name: String(name), args })}
			isProcessing={false}
			showAnimations={false}
			recentCommands={recent}
		/>,
		{
			stdin: stdin as unknown as NodeJS.ReadStream,
			stdout: stdout as unknown as NodeJS.WriteStream,
			stderr: makeStdout(columns, 40) as unknown as NodeJS.WriteStream,
			debug: false,
			exitOnCtrlC: false,
			patchConsole: false,
		},
	);
	await waitFor(() => stripAnsi(stdout.written).includes("Type a command"), "first frame");
	const type = async (text: string) => {
		stdin.feed(text);
		await tick(80);
	};
	const frame = () => frameText(stdout);
	return { calls, submitted, stdin, stdout, type, frame };
}

/** A tap as the terminal reports it, 0-based cell. */
function tap(x: number, y: number) {
	const ev = (final: "M" | "m"): MouseEvent => parseSgr(0, x + 1, y + 1, final);
	handleMouse(ev("M"));
	handleMouse(ev("m"));
}

/** The cells a row's target covers, found in the registry the way a finger finds them. */
function cellsOf(id: string, cols: number, rows = 40) {
	const out: [number, number][] = [];
	for (let y = 0; y < rows; y++)
		for (let x = 0; x < cols; x++) if (hitTest(x, y)?.id === id) out.push([x, y]);
	return out;
}

describe("Enter on a typed slash prefix", () => {
	test("/he then Enter runs /help", async () => {
		const { calls, submitted, type, frame } = await mount();
		await type("/he");
		expect(frame()).toContain("/help");
		await type("\r");
		expect(calls).toEqual([{ name: "help", args: [] }]);
		expect(submitted).toEqual([]);
	});

	test("/s then Enter runs nothing and keeps the list open", async () => {
		const { calls, submitted, type, frame } = await mount();
		await type("/s");
		await type("\r");
		expect(calls).toEqual([]);
		expect(submitted).toEqual([]);
		expect(frame()).toContain("/skills");
		expect(frame()).toContain("/s");
	});

	test("Down then Enter runs the row the person picked", async () => {
		const { calls, type } = await mount();
		await type("/s");
		await type("\x1b[B");
		await type("\r");
		expect(calls.length).toBe(1);
		expect(calls[0]?.args).toEqual([]);
	});

	test("Tab still puts the picked command in without running it", async () => {
		const { calls, type, frame } = await mount();
		await type("/he");
		await type("\t");
		expect(calls).toEqual([]);
		expect(frame()).toContain("/help");
	});

	test("input that does not start with / is a message, never completed", async () => {
		const { calls, submitted, type } = await mount();
		await type("he");
		await type("\r");
		expect(calls).toEqual([]);
		expect(submitted).toEqual(["he"]);
	});

	test("a full command with arguments runs as typed", async () => {
		const { calls, type } = await mount();
		await type("/help me");
		await type("\r");
		expect(calls).toEqual([{ name: "help", args: ["me"] }]);
	});
});

describe("the list rows are tap targets", () => {
	for (const columns of [52, 40]) {
		test(`at ${columns} columns: a tap on the centre or an edge cell of a row runs it`, async () => {
			for (const pick of ["mid", "first", "last"] as const) {
				const { calls, type, frame } = await mount(columns);
				await type("/he");
				for (const l of frame().split("\n")) expect([...l].length).toBeLessThanOrEqual(columns);
				expect(frame()).toContain("/help");
				const cells = cellsOf("slash:help", columns);
				expect(cells.length).toBeGreaterThanOrEqual(3);
				const [x, y] =
					pick === "first"
						? (cells[0] as [number, number])
						: pick === "last"
							? (cells[cells.length - 1] as [number, number])
							: (cells[Math.floor(cells.length / 2)] as [number, number]);
				tap(x, y);
				await tick(60);
				expect(calls).toEqual([{ name: "help", args: [] }]);
				instance?.unmount();
				instance = null;
				clearTargets();
			}
		});
	}

	test("at 40 columns the rows show names, and the picked row's description is whole under the list", async () => {
		const { type, frame } = await mount(40);
		await type("/s");
		const f = frame();
		expect(f).toContain("/skills");
		// The picked row's description stands whole under the list (the picked row is first).
		expect(f).toContain("Open settings view");
		expect(f).not.toContain("List and manage skills");
		for (const l of f.split("\n")) expect([...l].length).toBeLessThanOrEqual(40);
	});

	test("a tap on a row of an ambiguous list runs that row, not the first", async () => {
		const { calls, type } = await mount(52);
		await type("/s");
		const cells = cellsOf("slash:skills", 52);
		expect(cells.length).toBeGreaterThanOrEqual(3);
		const [x, y] = cells[1] as [number, number];
		tap(x, y);
		await tick(60);
		expect(calls).toEqual([{ name: "skills", args: [] }]);
	});
});

describe("the grey suggestion", () => {
	test("a tap on its [Tab] hint accepts it, as Tab does", async () => {
		const { type, frame } = await mount(52, ["run the tests for the tabs"]);
		await type("run the");
		await tick(600);
		expect(frame()).toContain("tap to accept");
		const before =
			frame()
				.split("\n")
				.find((l) => l.includes("❯")) ?? "";
		const cells = cellsOf("slash:accept", 52);
		expect(cells.length).toBeGreaterThanOrEqual(3);
		const [x, y] = cells[Math.floor(cells.length / 2)] as [number, number];
		tap(x, y);
		await tick(80);
		const after =
			frame()
				.split("\n")
				.find((l) => l.includes("❯")) ?? "";
		expect(after).not.toBe(before);
	});

	test("pickedDescription keeps two whole lines and cuts only past them", () => {
		expect(pickedDescription("List and manage skills", 36)).toEqual(["List and manage skills"]);
		const long = "word ".repeat(30).trim();
		const out = pickedDescription(long, 20);
		expect(out.length).toBe(2);
		expect(out[1]?.endsWith("…")).toBeTrue();
	});
});
