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
import { ModelSelector, PICKER_MIN_VISIBLE, fitVisible } from "../select-input";

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
		expect(fitVisible(8, 25)).toBe(5);
		expect(fitVisible(8, 10)).toBe(PICKER_MIN_VISIBLE);
		expect(fitVisible(8, undefined)).toBe(8);
	});
});

describe("model picker at 52 columns", () => {
	test("every line fits the width and each model is one row", async () => {
		const lines = await lastFrame(52, 25);
		const top = lines.map((l) => l.length);
		expect(Math.max(...top)).toBeLessThanOrEqual(52);
		const joined = lines.join("\n");
		// A wrapped hash would leave its tail alone on a row; truncation leaves an ellipsis.
		expect(joined).toContain("…");
		expect(joined).not.toMatch(/\n│\s+f293ff425a/);
		// 4 rows of chrome (border, title, blank, hint) plus the option rows and indicators.
		expect(lines.length).toBeLessThanOrEqual(25 - 11);
	});

	test("keeps its bottom border and the whole hint, with room to spare", async () => {
		const lines = await lastFrame(52, 25);
		const text = lines.join("\n");
		const lastBorder = text.lastIndexOf("╰");
		expect(lastBorder).toBeGreaterThan(-1);
		expect(text.lastIndexOf("[Esc] Cancel")).toBeLessThan(lastBorder);
		// Only the options that fit the screen are drawn.
		const drawn = MODELS.filter((m) => text.includes(m.slice(0, 8))).length;
		expect(drawn).toBeLessThanOrEqual(fitVisible(8, 25));
	});
});
