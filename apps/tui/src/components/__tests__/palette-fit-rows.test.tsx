/**
 * Palette fits the rows on screen (#5034): the key-cap row, the "n more" count
 * and the bottom border always draw, and at 100x32 the frame is the one it was
 * before the sheet looked at rows. Real Ink into a fake terminal.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { render } from "ink";
import type React from "react";
import { clearTargets } from "../../lib/click-targets.js";
import { CommandPaletteView, paletteGeometry, paletteRowSpans } from "../CommandPalette.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const COMMANDS = Array.from({ length: 40 }, (_, i) => ({
	name: ["help", "hotkeys", "clear", "quit", "model"][i] ?? `cmd${i}`,
	description:
		["Show available commands", "List every keyboard shortcut", "Clear the screen"][i] ??
		`Command number ${i}`,
}));

class FakeStdin extends EventEmitter {
	isTTY = true;
	setRawMode() {}
	setEncoding() {}
	ref() {}
	unref() {}
	read() {
		return null;
	}
}
const mounted: Array<() => void> = [];
afterEach(() => {
	for (const u of mounted.splice(0)) u();
	clearTargets();
});

function frame(node: React.ReactElement, cols: number, rows: number): string[] {
	const out = new EventEmitter() as EventEmitter & Record<string, unknown>;
	let last = "";
	Object.assign(out, { columns: cols, rows, isTTY: false });
	out.write = (s: string) => {
		const f = strip(s);
		if (f.trim()) last = f;
		return true;
	};
	const app = render(node, {
		stdout: out as unknown as NodeJS.WriteStream,
		stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
		debug: true,
		patchConsole: false,
		exitOnCtrlC: false,
	});
	mounted.push(() => app.unmount());
	return last.replace(/\n+$/, "").split("\n");
}
const view = (cols: number, rows?: number, active = 0) => (
	<CommandPaletteView
		query=""
		activeIndex={active}
		commands={COMMANDS}
		columns={cols}
		rows={rows}
	/>
);

describe("the sheet fits the rows on screen", () => {
	test("100x32 and 52x30 draw the same frame as before the sheet read rows", () => {
		for (const [c, r] of [
			[100, 32],
			[52, 30],
		] as const) {
			expect(frame(view(c, r), c, r)).toEqual(frame(view(c), c, r));
		}
		expect(paletteGeometry(100, 32).visibleRows).toBe(10);
		expect(paletteGeometry(52, 30).visibleRows).toBe(5);
	});

	test("52x16 keys-up: four rows, the place, the close key and the bottom border all draw", () => {
		const ls = frame(view(52, 16), 52, 16);
		expect(ls.length).toBeLessThanOrEqual(16 - 3);
		expect(ls.some((l) => l.includes("1-4/40"))).toBe(true);
		expect(ls.some((l) => l.includes("[Esc] close"))).toBe(true);
		expect(ls.at(-1)).toMatch(/^╰─+╯$/);
		if (process.env.PALETTE_FRAMES) {
			const b = frame(view(52), 52, 16);
			writeFileSync(
				process.env.PALETTE_FRAMES,
				`BEFORE\n${b.join("\n")}\nAFTER\n${ls.join("\n")}\n`,
			);
		}
	});

	test("80x24: five rows, the legend kept; a middle row shows both counts", () => {
		const ls = frame(view(80, 24, 20), 80, 24);
		expect(ls.length).toBeLessThanOrEqual(24 - 11);
		expect(ls.some((l) => l.includes("↑") && l.includes("more"))).toBe(true);
		expect(ls.some((l) => l.includes("↓") && l.includes("more"))).toBe(true);
		expect(ls.some((l) => l.includes("[Esc] close"))).toBe(true);
		expect(ls.at(-1)).toMatch(/^╰─+╯$/);
	});

	test("never fewer than two rows, and a tap lands on the row it shows", () => {
		expect(paletteGeometry(52, 8).visibleRows).toBe(2);
		expect(paletteRowSpans(52, 40, 0, 16).length).toBe(4);
		expect(paletteRowSpans(52, 40, 0, 30).length).toBe(5);
	});
});
