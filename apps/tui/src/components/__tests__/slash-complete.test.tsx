/**
 * Slash commands complete without Tab (#4934). Artale on a phone: "the command
 * don't auto complete, i had to use tab". Typing / already opens a narrowing
 * list; now Enter on a prefix that names one command runs it, an ambiguous
 * prefix keeps the list and runs nothing, Up/Down plus Enter pick a row, and
 * every row is a tap target (#4922). Driven through the real CommandInput.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { Box, type Instance, render, useInput } from "ink";
import React from "react";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearTargets, handleMouse, hitTest } from "../../lib/click-targets.js";
import { type MouseEvent, parseSgr } from "../../lib/mouse-input.js";
import { getBuiltInSlashRegistry, getSlashRegistry } from "../../lib/slash-registry.js";
import {
	CommandInput,
	SLASH_NEVER_FROM_PREFIX,
	pickedDescription,
	slashEnterAction,
} from "../command-input.js";

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

// The app keeps its state under the working directory: tests work in a throwaway one.
const ORIGINAL_CWD = process.cwd();
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "slash-complete-"));
process.chdir(WORK);
afterAll(() => {
	process.chdir(ORIGINAL_CWD);
	fs.rmSync(WORK, { recursive: true, force: true });
});

/** A built-in that some short prefix names alone in the whole registry, and is safe to run from a prefix. */
function unique(entries: ReturnType<typeof getBuiltInSlashRegistry>["entries"]) {
	for (const e of entries) {
		if (e.kind !== "builtin" || !e.builtInName || e.name !== e.canonicalName) continue;
		if (SLASH_NEVER_FROM_PREFIX.has(e.builtInName)) continue;
		for (let n = 2; n < e.name.length; n++) {
			const prefix = e.name.slice(0, n).toLowerCase();
			const m = entries.filter((x) => x.name.toLowerCase().startsWith(prefix));
			if (m.length === 1 && !entries.some((x) => x.name.toLowerCase() === prefix))
				return { prefix, entry: e };
		}
	}
	return null;
}

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
	test("a prefix that two commands share (/he: help and herdr) runs nothing and keeps the list", async () => {
		const { calls, submitted, type, frame } = await mount();
		await type("/he");
		expect(frame()).toContain("/help");
		await type("\r");
		expect(calls).toEqual([]);
		expect(submitted).toEqual([]);
		expect(frame()).toContain("/herdr");
	});

	test("the full name runs as typed: /help then Enter runs /help", async () => {
		const { calls, type } = await mount();
		await type("/help");
		await type("\r");
		expect(calls).toEqual([{ name: "help", args: [] }]);
	});

	test("/se then Enter runs nothing and keeps the list open", async () => {
		const { calls, submitted, type, frame } = await mount();
		await type("/se");
		await type("\r");
		expect(calls).toEqual([]);
		expect(submitted).toEqual([]);
		expect(frame()).toContain("/settings");
		expect(frame()).toContain("/se");
	});

	test("a prefix that only one command in the whole registry starts with runs it", async () => {
		const reg = await getSlashRegistry();
		const pick = unique(reg.entries);
		expect(pick).not.toBeNull();
		const { calls, type } = await mount();
		await type(`/${pick?.prefix}`);
		await type("\r");
		expect(calls.map((c) => c.name)).toEqual([String(pick?.entry.builtInName)]);
	});

	test("Down then Enter runs the row the person picked", async () => {
		const { calls, submitted, type } = await mount();
		await type("/se");
		await type("\x1b[B");
		await type("\r");
		// The second row may be a built-in (slash command) or a skill (submitted as a line): one of them ran.
		expect(calls.length + submitted.length).toBe(1);
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

describe("slashEnterAction, over the whole built-in registry", () => {
	const { entries } = getBuiltInSlashRegistry();
	const target = (e: (typeof entries)[number]) => e.builtInName ?? e.token;
	const prefixes = new Set<string>();
	for (const e of entries)
		for (let n = 1; n < e.name.length; n++) prefixes.add(e.name.slice(0, n).toLowerCase());

	test("a prefix that more than one command starts never runs", () => {
		const bad: string[] = [];
		for (const p of prefixes) {
			const m = entries.filter((e) => e.name.toLowerCase().startsWith(p));
			const exact = m.some((e) => e.name.toLowerCase() === p);
			if (
				new Set(m.map(target)).size > 1 &&
				!exact &&
				slashEnterAction(`/${p}`, entries, null).kind === "run"
			)
				bad.push(p);
		}
		expect(bad).toEqual([]);
	});

	test("every exact command name and alias runs as typed", () => {
		const bad = entries
			.filter((e) => slashEnterAction(`/${e.name}`, entries, null).kind !== "pass")
			.map((e) => e.name);
		expect(bad).toEqual([]);
	});

	test("commands that end the session or discard work never run from a prefix", () => {
		const ran: string[] = [];
		for (const name of SLASH_NEVER_FROM_PREFIX) {
			for (let n = 1; n < name.length; n++) {
				const a = slashEnterAction(`/${name.slice(0, n)}`, entries, null);
				if (a.kind === "run") ran.push(`${name.slice(0, n)} -> ${a.name}`);
			}
		}
		expect(ran).toEqual([]);
		// ...but a picked row is an explicit choice, and the full name is as typed.
		const quit = entries.find((e) => e.name === "quit");
		expect(slashEnterAction("/qui", entries, quit ?? null)).toEqual({ kind: "run", name: "quit" });
		expect(slashEnterAction("/quit", entries, null).kind).toBe("pass");
	});

	test("leading space and a trailing newline change nothing; arguments and messages pass", () => {
		for (const p of ["cl", "se", "he", "qui"]) {
			const plain = slashEnterAction(`/${p}`, entries, null);
			expect(slashEnterAction(` /${p}`, entries, null)).toEqual(plain);
			expect(slashEnterAction(`/${p}\n`, entries, null)).toEqual(plain);
		}
		expect(slashEnterAction("/c foo", entries, null).kind).toBe("pass");
		expect(slashEnterAction("hello", entries, null).kind).toBe("pass");
		expect(slashEnterAction("/", entries, null).kind).toBe("pass");
	});

	test("the aliases the reviewer named run as typed", () => {
		for (const a of ["p", "c", "s", "st", "h", "pl", "k", "a", "v", "t", "d", "b", "sess", "eye"]) {
			if (entries.some((e) => e.name === a))
				expect(slashEnterAction(`/${a}`, entries, null).kind).toBe("pass");
		}
	});
});

describe("tap spans are the row, not the screen", () => {
	test("a row's target ends 3 cells past its text; the empty line beyond is not a button", async () => {
		const { type } = await mount(100);
		await type("/he");
		const cells = cellsOf("slash:help", 100);
		expect(cells.length).toBeGreaterThanOrEqual(3);
		const text = "  /help Show available commands";
		expect(cells.length).toBeLessThanOrEqual([...text].length + 3);
		expect(hitTest(95, cells[0]?.[1] ?? 0)?.id).not.toBe("slash:help");
	});
});
