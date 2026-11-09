/**
 * Pilot break 11: in a 52 column terminal the /model picker wrapped long model
 * names onto second lines, grew taller than the screen, and lost its bottom
 * border (the frame's corners landed inside the hint line). Every option is now
 * one line and the list is capped to the rows the screen has.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { render } from "ink";
import React from "react";
import {
	ModelSelector,
	PICKER_CHROME_ROWS,
	PICKER_MIN_VISIBLE,
	PICKER_NARROW_COLUMNS,
	fitVisible,
	isCompactPicker,
	pickerHint,
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
	read(): string | null {
		return null;
	}
}

type FakeStdout = Writable & { columns: number; rows: number; written: string };
function makeStdout(cols: number, rows: number): FakeStdout {
	const out = new Writable({
		write(chunk, _enc, cb) {
			out.written += chunk.toString();
			cb();
		},
	}) as FakeStdout;
	out.written = "";
	out.columns = cols;
	out.rows = rows;
	return out;
}

const MODELS = [
	"8gate:latest",
	"llamacpp:c97eb11d70b1acdc88af01eef566c1fe4f7fbe93eb1afc06871132f293ff425a",
	"qwen3.5:9b",
	"llamacpp:3df2de16f8eba44d731065a645f5e3552f3e25b30906b3ba17539555ba7f846e",
	"qwen3.5:9b-32k",
	"qwen3.8:27b-mlx",
	"hf.co/AtlaAI/Selene-1-Mini-Llama-3.1-8B-Q4_K_M-GGUF:latest",
	"hf.co/openbmb/MiniCPM5-1B-GGUF:Q8_0",
	"another-long-model-name-that-keeps-going-and-going:latest",
	"tenth:latest",
];

async function lastFrame(cols: number, rows: number): Promise<string[]> {
	const stdout = makeStdout(cols, rows);
	const app = render(
		<ModelSelector
			models={MODELS}
			currentModel="qwen3.8:27b-mlx"
			onSelect={() => {}}
			onCancel={() => {}}
			provider="ollama"
		/>,
		{
			stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
			stdout: stdout as unknown as NodeJS.WriteStream,
			stderr: makeStdout(cols, rows) as unknown as NodeJS.WriteStream,
			debug: true,
			exitOnCtrlC: false,
			patchConsole: false,
		},
	);
	await wait(150);
	app.unmount();
	const all = strip(stdout.written);
	// Debug mode appends whole frames with no separator; keep only the last one.
	return all.slice(all.lastIndexOf("╭")).split("\n");
}

describe("fitVisible", () => {
	test("never exceeds the caller's cap, never drops below the floor", () => {
		expect(fitVisible(8, 60)).toBe(8);
		expect(fitVisible(8, 30)).toBe(7);
		expect(fitVisible(8, 10)).toBe(PICKER_MIN_VISIBLE);
		expect(fitVisible(8, undefined)).toBe(8);
	});
});

describe("model picker borders and hint (design fix)", () => {
	const cases: Array<[number, number]> = [
		[52, 24],
		[52, 27],
		[52, 30],
		[44, 24],
	];
	for (const [cols, rows] of cases) {
		test(`${cols}x${rows}: fits the rows, keeps the bottom border, whole hint, no wrapped ids`, async () => {
			const lines = await lastFrame(cols, rows);
			const text = lines.join("\n");
			expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(cols);
			// The app draws 11 rows around a picker.
			expect(lines.length).toBeLessThanOrEqual(rows - 11);
			// Bottom border is the last row, and the hint sits above it.
			expect(lines[lines.length - 1]).toStartWith("╰");
			const hintRow = lines[lines.length - 2] ?? "";
			expect(hintRow).toContain("Esc");
			expect(hintRow).toContain(cols < PICKER_NARROW_COLUMNS ? "type to filter" : "[type] Filter");
			expect(hintRow).not.toContain("…");
			expect(text).toContain("…");
			expect(text).not.toMatch(/\n│\s+f293ff425a/);
		});
	}

	test("under 26 rows the description and spacer rows are dropped", async () => {
		const compact = (await lastFrame(52, 24)).join("\n");
		const roomy = (await lastFrame(52, 40)).join("\n");
		expect(compact).not.toContain("Currently active");
		expect(roomy).toContain("Currently active");
	});

	test("PICKER_CHROME_ROWS counts the description and the scroll lines", () => {
		expect(PICKER_CHROME_ROWS).toBe(23);
		expect(isCompactPicker(25)).toBe(true);
		expect(isCompactPicker(26)).toBe(false);
	});
});

describe("pickerHint", () => {
	test("long form wide, short form that keeps Esc and the filter tip when narrow", () => {
		expect(pickerHint(80, true)).toContain("[Esc] Cancel");
		expect(pickerHint(52, true)).toBe("↑↓ Enter Esc  type to filter");
		expect(pickerHint(44, false)).toBe("↑↓ Enter Esc");
	});

	test("the long form fits the card at the width where it is used", () => {
		expect(pickerHint(PICKER_NARROW_COLUMNS, true).length).toBeLessThanOrEqual(
			PICKER_NARROW_COLUMNS - 10,
		);
	});
});
