/**
 * Short terminals: /model opened at 14 rows with no model rows and no key hint,
 * and Enter then picked a model nobody could see. The picker is drawn inside the
 * rows the app leaves it: terminal rows minus 13 with the full chrome, minus 5
 * once the app hides its banner, tabs and NOW strip for it (under 21 rows). It
 * opens down to PICKER_MIN_ROWS (9), shows 3 or more rows with the marked one,
 * and Enter picks the row that is marked. Under 9 rows it refuses and Enter does
 * nothing. The app side (the chrome really goes away) is model-picker-short-app.test.tsx.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { render } from "ink";
import React from "react";
import {
	ModelSelector,
	PICKER_APP_ROWS,
	PICKER_MIN_ROWS,
	PICKER_MIN_VISIBLE,
	PICKER_SHORT_APP_ROWS,
	pickerHidesChrome,
	pickerLayout,
} from "../select-input";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const strip = (s: string) => s.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeStdin extends EventEmitter {
	isTTY = true;
	setRawMode() {}
	setEncoding() {}
	ref() {}
	unref() {}
	private queue: string[] = [];
	read(): string | null {
		return this.queue.shift() ?? null;
	}
	feed(chunk: string) {
		this.queue.push(chunk);
		this.emit("readable");
	}
}
type FakeStdout = Writable & { columns: number; rows: number; written: string; last: string };
function makeStdout(cols: number, rows: number): FakeStdout {
	const out = new Writable({
		write(chunk, _enc, cb) {
			out.written += chunk.toString();
			out.last = chunk.toString();
			cb();
		},
	}) as FakeStdout;
	out.written = "";
	out.last = "";
	out.columns = cols;
	out.rows = rows;
	return out;
}

const MODELS = Array.from({ length: 14 }, (_, i) => `model-${String(i).padStart(2, "0")}:latest`);
const DOWN = "\u001B[B";
const UP = "\u001B[A";

async function open(rows: number, current = MODELS[5], models = MODELS) {
	const picked: string[] = [];
	let cancelled = 0;
	const stdin = new FakeStdin();
	const stdout = makeStdout(80, rows);
	const app = render(
		<ModelSelector
			models={models}
			currentModel={current}
			onSelect={(m) => picked.push(m)}
			onCancel={() => {
				cancelled++;
			}}
			provider="ollama"
		/>,
		{
			stdin: stdin as unknown as NodeJS.ReadStream,
			stdout: stdout as unknown as NodeJS.WriteStream,
			stderr: makeStdout(80, rows) as unknown as NodeJS.WriteStream,
			debug: true,
			exitOnCtrlC: false,
			patchConsole: false,
		},
	);
	await wait(400);
	// The last frame Ink wrote is what a person is looking at.
	const frame = () =>
		strip(stdout.last)
			.split("\n")
			.filter((l, i, a) => l !== "" || i < a.length - 1);
	const key = async (s: string) => {
		stdin.feed(s);
		await wait(80);
	};
	return { frame, key, picked, cancelled: () => cancelled, stop: () => app.unmount() };
}

/** What a frame shows: the model rows, the marked one, and the numbers in the hint. */
function read(lines: string[]) {
	const rows = lines.filter((l) => /model-\d\d/.test(l));
	const idx = rows.map((l) => Number(l.match(/model-(\d\d)/)?.[1]));
	const marked = lines.filter((l) => l.includes("\u276F"));
	const text = lines.join("\n");
	return {
		text,
		rows,
		first: idx[0],
		last: idx[idx.length - 1],
		marked,
		markedName: marked[0]?.match(/model-\d\d:latest/)?.[0],
		above: Number(text.match(/(\d+) more above/)?.[1] ?? 0),
		below: Number(text.match(/(\d+) more below/)?.[1] ?? 0),
	};
}

/** The lines the picker may use at a height: rows minus what the app keeps. */
const budget = (rows: number) =>
	rows - (pickerHidesChrome(rows) ? PICKER_SHORT_APP_ROWS : PICKER_APP_ROWS);

describe("model picker on short terminals", () => {
	for (const rows of [24, 14, 10]) {
		test(`${rows} rows: opens inside its budget, 3+ rows, current model marked, hint counts match`, async () => {
			const p = await open(rows);
			const lines = p.frame();
			const v = read(lines);
			expect(lines.length).toBeLessThanOrEqual(budget(rows));
			expect(v.rows.length).toBeGreaterThanOrEqual(PICKER_MIN_VISIBLE);
			expect(v.marked.length).toBe(1);
			expect(v.markedName).toBe("model-05:latest");
			expect(v.marked[0]).toContain("\u2713");
			// The list is cut, so the hint says by how much, from the real counts.
			expect(v.above).toBe(v.first);
			expect(v.below).toBe(MODELS.length - 1 - v.last);
			expect(v.above + v.rows.length + v.below).toBe(MODELS.length);
			expect(v.text).toContain("Enter");
			expect(v.text).toContain("Esc");
			p.stop();
		});

		test(`${rows} rows: the hint is absent when nothing is cut`, async () => {
			const few = MODELS.slice(0, 3);
			const p = await open(rows, few[1], few);
			const v = read(p.frame());
			expect(v.rows.length).toBe(3);
			expect(v.text).not.toMatch(/more (above|below)/);
			expect(v.text).toContain("Enter");
			p.stop();
		});

		test(`${rows} rows: Enter picks the row that is marked, also after moving`, async () => {
			const p = await open(rows);
			expect(read(p.frame()).markedName).toBe("model-05:latest");
			await p.key("\r");
			expect(p.picked).toEqual(["model-05:latest"]);
			await p.key(DOWN);
			await p.key(DOWN);
			const v = read(p.frame());
			expect(v.markedName).toBe("model-07:latest");
			await p.key("\r");
			expect(p.picked).toEqual(["model-05:latest", "model-07:latest"]);
			p.stop();
		});

		test(`${rows} rows: arrows move the highlight and scroll the window, counts follow`, async () => {
			const p = await open(rows);
			for (let i = 0; i < MODELS.length; i++) {
				await p.key(DOWN);
				const v = read(p.frame());
				expect(v.marked.length).toBe(1);
				expect(v.above).toBe(v.first);
				expect(v.below).toBe(MODELS.length - 1 - v.last);
			}
			let v = read(p.frame());
			expect(v.markedName).toBe("model-13:latest");
			expect(v.below).toBe(0);
			expect(v.text).not.toContain("more below");
			expect(v.above).toBeGreaterThan(0);
			for (let i = 0; i < MODELS.length; i++) await p.key(UP);
			v = read(p.frame());
			expect(v.markedName).toBe("model-00:latest");
			expect(v.first).toBe(0);
			expect(v.text).not.toContain("more above");
			await p.key("\r");
			expect(p.picked).toEqual(["model-00:latest"]);
			p.stop();
		});
	}

	test(`${PICKER_MIN_ROWS} rows is the smallest that opens: 3 rows, marked, Enter picks it`, async () => {
		const p = await open(PICKER_MIN_ROWS);
		const v = read(p.frame());
		expect(v.rows.length).toBeGreaterThanOrEqual(PICKER_MIN_VISIBLE);
		expect(v.markedName).toBe("model-05:latest");
		await p.key("\r");
		expect(p.picked).toEqual(["model-05:latest"]);
		p.stop();
	});

	for (const rows of [PICKER_MIN_ROWS - 1, 6]) {
		test(`${rows} rows (under the minimum): one plain refusal line, Enter selects nothing`, async () => {
			const p = await open(rows);
			const lines = p.frame().filter((l) => l.trim());
			expect(lines.length).toBe(1);
			expect(lines[0]).toContain("Make it taller");
			expect(lines[0]).toContain(`needs ${PICKER_MIN_ROWS} rows, has ${rows}`);
			expect(lines[0]).toContain("/model <name>");
			expect(lines[0]).not.toContain("model-");
			await p.key("\r");
			await p.key(DOWN);
			await p.key("\r");
			expect(p.picked).toEqual([]);
			await p.key("\u001B");
			expect(p.cancelled()).toBe(1);
			p.stop();
		});
	}

	test("a blind pick is impossible: whatever Enter picks is the row the frame shows marked", async () => {
		for (const rows of [24, 14, 10, 9]) {
			const p = await open(rows, MODELS[9]);
			const shown = read(p.frame()).markedName;
			expect(shown).toBe("model-09:latest");
			await p.key("\r");
			expect(p.picked).toEqual([shown as string]);
			p.stop();
		}
	});

	test("the marked row is always on screen while moving down the whole list", async () => {
		const p = await open(17);
		for (let i = 0; i < MODELS.length + 2; i++) {
			await p.key(DOWN);
			const marked = p.frame().filter((l) => l.includes("\u276F"));
			expect(marked.length).toBe(1);
		}
		await p.key("\r");
		expect(p.picked).toEqual([MODELS[MODELS.length - 1]]);
		p.stop();
	});

	test("Esc closes and picks nothing, even when refusing", async () => {
		for (const rows of [6, 14, 18]) {
			const p = await open(rows);
			await p.key("\u001B");
			expect(p.cancelled()).toBe(1);
			expect(p.picked).toEqual([]);
			p.stop();
		}
	});

	test("layout: the minimum is 9 rows; 3 rows or more from there up, to the full-chrome heights", () => {
		expect(PICKER_MIN_ROWS).toBe(9);
		expect(pickerLayout(PICKER_MIN_ROWS - 1, MODELS.length, false, 8).refuse).toBe(true);
		for (let rows = PICKER_MIN_ROWS; rows < 26; rows++) {
			const l = pickerLayout(rows, MODELS.length, false, 8);
			expect(l.refuse).toBe(false);
			expect(l.visible).toBeGreaterThanOrEqual(PICKER_MIN_VISIBLE);
		}
		expect(pickerHidesChrome(20)).toBe(true);
		expect(pickerHidesChrome(21)).toBe(false);
		expect(pickerHidesChrome(undefined)).toBe(false);
	});
});
