/**
 * The / menu, rendered: a bare `/` shows /copy and /hotkeys, the menu
 * follows the terminal height, and Up/Down reach every row (#3918 D9, 8PO).
 *
 * Mounts the real CommandInput through Ink with an in-memory stdin/stdout,
 * the repo's render-test pattern (command-input-enter.test.tsx); the repo
 * has no ink-testing-library.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { type Instance, render } from "ink";
import {
	CommandInput,
	SLASH_MENU_ROWS,
	slashMenuCompact,
	slashMenuVisibleRows,
	slashMenuWindow,
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
	feed(chunk: string) {
		this.queue.push(chunk);
		this.emit("readable");
	}
}

type FakeStdout = Writable & { columns: number; rows: number; written: string };

function makeStdout(rows: number): FakeStdout {
	const out = new Writable({
		write(chunk, _enc, cb) {
			out.written += chunk.toString();
			cb();
		},
	}) as FakeStdout;
	out.written = "";
	out.columns = 100;
	out.rows = rows;
	return out;
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const strip = (s: string) => s.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");

async function waitFor(check: () => boolean, label: string, timeoutMs = 5000) {
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

/** Mount CommandInput in a terminal `rows` tall and type a bare `/`. */
async function openMenu(rows: number) {
	const stdin = new FakeStdin();
	const stdout = makeStdout(rows);
	instance = render(
		<CommandInput onSubmit={() => {}} isProcessing={false} showAnimations={false} />,
		{
			stdin: stdin as unknown as NodeJS.ReadStream,
			stdout: stdout as unknown as NodeJS.WriteStream,
			stderr: makeStdout(rows) as unknown as NodeJS.WriteStream,
			debug: false,
			exitOnCtrlC: false,
			patchConsole: false,
		},
	);
	await waitFor(() => strip(stdout.written).includes("Type a command"), "first frame");
	// The registry loads after mount; the menu draws once it has.
	await tick(300);
	let mark = stdout.written.length;
	stdin.feed("/");
	await waitFor(() => strip(stdout.written.slice(mark)).includes("> /clear"), "menu open");
	await tick(50);
	/** The last frame Ink drew. */
	const frame = () => {
		const s = strip(stdout.written);
		return s.slice(s.lastIndexOf("❯"));
	};
	const picked = () => frame().match(/> \/([a-z-]+)/)?.[1] ?? "";
	const press = async (key: string) => {
		mark = stdout.written.length;
		stdin.feed(key);
		await tick(60);
	};
	return { frame, picked, press };
}

const rowsIn = (frame: string) => (frame.match(/^\s*│?\s*(?:> | {2})\/[a-z-]+ /gm) ?? []).length;

describe("/ menu (#3918 D9)", () => {
	test("visible rows follow the terminal: min(14, rows - chrome)", () => {
		expect(slashMenuVisibleRows(12)).toBe(1);
		expect(slashMenuVisibleRows(18)).toBe(7);
		expect(slashMenuVisibleRows(29)).toBe(SLASH_MENU_ROWS);
		expect(slashMenuVisibleRows(30)).toBe(12);
		expect(slashMenuVisibleRows(60)).toBe(SLASH_MENU_ROWS);
		expect(slashMenuVisibleRows(5)).toBe(1);
		expect(slashMenuCompact(29)).toBeTrue();
		expect(slashMenuCompact(30)).toBeFalse();
	});

	test("the window keeps the picked row in view", () => {
		expect(slashMenuWindow(14, 0, 14)).toEqual({ start: 0, end: 14 });
		expect(slashMenuWindow(14, 0, 3)).toEqual({ start: 0, end: 3 });
		expect(slashMenuWindow(14, 7, 3)).toEqual({ start: 6, end: 9 });
		expect(slashMenuWindow(14, 13, 3)).toEqual({ start: 11, end: 14 });
	});

	test("a bare / shows the /copy and /hotkeys rows", async () => {
		const { frame } = await openMenu(40);
		expect(frame()).toContain("/copy Copy the last answer");
		expect(frame()).toContain("/hotkeys List every keyboard shortcut");
		expect(rowsIn(frame())).toBe(14);
		expect(frame()).not.toContain("Up/Down to scroll");
	});

	for (const rows of [12, 18]) {
		test(`at ${rows} rows the menu shows ${slashMenuVisibleRows(rows)} and scrolling reaches all 14`, async () => {
			const { frame, picked, press } = await openMenu(rows);
			const visible = slashMenuVisibleRows(rows);
			expect(rowsIn(frame())).toBe(visible);
			expect(frame()).toContain(`1-${visible} of 14, Up/Down to scroll`);
			const seen = [picked()];
			for (let i = 0; i < 16; i++) {
				await press("\x1b[B");
				seen.push(picked());
				expect(rowsIn(frame())).toBe(visible);
			}
			const unique = [...new Set(seen)];
			expect(unique).toHaveLength(14);
			expect(unique).toContain("copy");
			expect(unique).toContain("hotkeys");
			expect(unique.at(-1)).toBe("skills");
			expect(frame()).toContain(`${15 - visible}-14 of 14`);
			for (let i = 0; i < 16; i++) await press("\x1b[A");
			expect(picked()).toBe("clear");
		});
	}

	test("Tab puts the picked command in the input", async () => {
		const { frame, press } = await openMenu(40);
		await press("\x1b[B");
		await press("\x1b[B");
		await press("\t");
		expect(frame()).toContain("❯ /copy");
	});
});
