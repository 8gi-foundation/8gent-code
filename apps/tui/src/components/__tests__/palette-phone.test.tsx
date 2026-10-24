/**
 * Phone palette (#4951): the sheet fits the screen, a phone row is two lines
 * and a tap target, and a tap holds 120 ms before it runs. Rendered through
 * real Ink into a fake terminal at 100x32, 52x30 and 40x24.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { clearTargets, hitTest } from "../../lib/click-targets.js";
import { SETTLE_HOLD_MS } from "../../lib/motion.js";
import {
	CommandPalette,
	PALETTE_MAX_WIDTH,
	paletteGeometry,
	paletteRowSpans,
	paletteWidth,
} from "../CommandPalette.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

const COMMANDS = [
	["help", "Show available commands"],
	["hotkeys", "List every keyboard shortcut"],
	["provider", "Select LLM provider and then a very long description that cannot fit"],
	["clear", "Clear the screen"],
	["quit", "Exit 8gent Code"],
	["model", "Select LLM model"],
	["voice", "Voice settings"],
].map(([name, description]) => ({ name: name as string, description: description as string }));

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

const mounted: Array<() => void> = [];
afterEach(() => {
	for (const u of mounted.splice(0)) u();
	clearTargets();
});

function mount(
	cols: number,
	rows: number,
	extra: { animate?: boolean; commands?: typeof COMMANDS } = {},
) {
	const out = new EventEmitter() as EventEmitter & {
		columns: number;
		rows: number;
		isTTY: boolean;
		last: string;
		write: (s: string) => boolean;
	};
	out.columns = cols;
	out.rows = rows;
	out.isTTY = false;
	out.last = "";
	out.write = (s) => {
		const f = strip(s);
		if (f.trim()) out.last = f;
		return true;
	};
	const calls: string[] = [];
	const app = render(
		<CommandPalette
			isOpen
			columns={cols}
			animate={extra.animate ?? true}
			onClose={() => calls.push("close")}
			onExecute={(n) => calls.push(`run:${n}`)}
			commands={extra.commands ?? COMMANDS}
		/>,
		{
			stdout: out as unknown as NodeJS.WriteStream,
			stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
			debug: true,
			patchConsole: false,
			exitOnCtrlC: false,
		},
	);
	mounted.push(() => app.unmount());
	return { lines: () => out.last.replace(/\n+$/, "").split("\n"), calls };
}

describe("geometry", () => {
	test("width is the screen less two, never past 64", () => {
		expect(paletteWidth(40)).toBe(38);
		expect(paletteWidth(52)).toBe(50);
		expect(paletteWidth(100)).toBe(PALETTE_MAX_WIDTH);
		expect(paletteWidth(300)).toBe(PALETTE_MAX_WIDTH);
	});

	test("below 60 columns: two-line rows, five visible; from 60: one line, ten", () => {
		expect(paletteGeometry(59)).toMatchObject({ narrow: true, rowHeight: 2, visibleRows: 5 });
		expect(paletteGeometry(60)).toMatchObject({ narrow: false, rowHeight: 1, visibleRows: 10 });
	});

	test("row spans are at least two cells tall on a phone and never overlap", () => {
		const spans = paletteRowSpans(40, 77, 0);
		expect(spans.length).toBe(5);
		for (const s of spans) expect(s.h).toBeGreaterThanOrEqual(2);
		for (let i = 1; i < spans.length; i++) {
			expect(spans[i]!.dy).toBe(spans[i - 1]!.dy + spans[i - 1]!.h);
		}
	});
});

describe("renders inside the screen", () => {
	for (const [cols, rows] of [
		[100, 32],
		[52, 30],
		[40, 24],
	] as const) {
		test(`${cols}x${rows}: no line is wider than the screen; every row starts with marker and one space`, async () => {
			const { lines } = mount(cols, rows);
			await sleep(40);
			for (const l of lines()) expect([...l].length).toBeLessThanOrEqual(cols);
			const rowsText = lines().filter((l) => /^│ [◆○] \//.test(l));
			expect(rowsText.length).toBe(cols < 60 ? 5 : 7);
			const nameCols = new Set(rowsText.map((l) => l.indexOf("/")));
			expect(nameCols.size).toBe(1);
		});
	}

	test("40 columns: a command is its name, then its description on the line below", async () => {
		const { lines } = mount(40, 24);
		await sleep(40);
		const ls = lines();
		const i = ls.findIndex((l) => l.includes("◆ /help"));
		expect(i).toBeGreaterThan(0);
		expect(ls[i + 1]).toContain("  Show available commands");
		expect(ls[i + 1]).not.toContain("/");
		// The long description ends in an ellipsis at the inner width, never wraps.
		const j = ls.findIndex((l) => l.includes("○ /provider"));
		expect(ls[j + 1]).toContain("…");
		expect(ls.some((l) => l.includes("[↑↓] move [Enter] run [Esc] close"))).toBe(true);
	});

	test("52 columns is two-line too, the sheet 50 wide, and the border closes", async () => {
		const { lines } = mount(52, 30);
		await sleep(40);
		const ls = lines();
		expect(ls[0]).toMatch(/^╭─+╮$/);
		expect([...(ls[0] as string)].length).toBe(50);
		expect(ls.at(-1)).toMatch(/^╰─+╯$/);
	});
});

describe("tap", () => {
	test("a tap holds the row 120 ms, then closes and runs in Enter's order", async () => {
		const { calls } = mount(40, 24);
		await sleep(40);
		// Second row, second line of it: the whole two lines are one target.
		const spans = paletteRowSpans(40, COMMANDS.length, 0);
		const second = spans[1]!;
		const hit = hitTest(second.dx + 1, second.dy + 1);
		expect(hit?.id).toBe("palette:row:1");
		hit?.action();
		await sleep(30);
		expect(calls).toEqual([]);
		await sleep(SETTLE_HOLD_MS + 60);
		expect(calls).toEqual(["close", "run:hotkeys"]);
		await sleep(200);
		expect(calls.length).toBe(2);
	});

	test("the held row draws its orange marker during the hold", async () => {
		const { lines } = mount(40, 24);
		await sleep(40);
		const second = paletteRowSpans(40, COMMANDS.length, 0)[1]!;
		hitTest(second.dx, second.dy)?.action();
		await sleep(40);
		expect(lines().some((l) => l.includes("◆ /hotkeys"))).toBe(true);
	});

	test("with animation off a tap runs at once", async () => {
		const { calls } = mount(40, 24, { animate: false });
		await sleep(40);
		const first = paletteRowSpans(40, COMMANDS.length, 0)[0]!;
		hitTest(first.dx, first.dy)?.action();
		expect(calls).toEqual(["close", "run:help"]);
	});

	test("a second tap during the hold does not run twice", async () => {
		const { calls } = mount(52, 30);
		await sleep(40);
		const spans = paletteRowSpans(52, COMMANDS.length, 0);
		hitTest(spans[0]!.dx, spans[0]!.dy)?.action();
		hitTest(spans[2]!.dx, spans[2]!.dy)?.action();
		await sleep(SETTLE_HOLD_MS + 80);
		expect(calls).toEqual(["close", "run:help"]);
	});
});
