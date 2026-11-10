/**
 * Short terminals: /model opened at 14 rows with no model rows and no key hint,
 * and Enter then picked a model nobody could see. The picker is drawn inside the
 * rows the app leaves it (terminal rows minus 11). At every height from 10 rows
 * it shows the marked row and the hint, or refuses and Enter does nothing.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { render } from "ink";
import React from "react";
import { ModelSelector, PICKER_APP_ROWS, pickerLayout } from "../select-input";

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

const MODELS = Array.from({ length: 14 }, (_, i) => `model-${String(i).padStart(2, "0")}:latest`);
const HEIGHTS = [10, 12, 14, 16, 20, 24];

async function open(rows: number, current = MODELS[0]) {
	const picked: string[] = [];
	let cancelled = 0;
	const stdin = new FakeStdin();
	const stdout = makeStdout(80, rows);
	const app = render(
		<ModelSelector
			models={MODELS}
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
	const frame = () => {
		const all = strip(stdout.written);
		const start = all.lastIndexOf("╭");
		const tail = start >= 0 ? all.slice(start) : all;
		return tail.split("\n");
	};
	const key = async (s: string) => {
		stdin.feed(s);
		await wait(80);
	};
	return { frame, key, picked, cancelled: () => cancelled, stop: () => app.unmount() };
}

describe("model picker on short terminals", () => {
	for (const rows of HEIGHTS) {
		test(`${rows} rows: marked row and hint visible and inside the budget, or a refusal`, async () => {
			const p = await open(rows, MODELS[5]);
			const lines = p.frame();
			const text = lines.join("\n");
			const layout = pickerLayout(rows, MODELS.length, false, 8);
			if (layout.refuse) {
				expect(lines.filter((l) => l.trim()).length).toBe(1);
				expect(text).toContain("taller");
				await p.key("\r");
				expect(p.picked).toEqual([]);
			} else {
				expect(lines.length).toBeLessThanOrEqual(rows - PICKER_APP_ROWS);
				expect(text).toContain("Enter");
				expect(text).toContain("Esc");
				const marked = lines.filter((l) => l.includes("❯"));
				expect(marked.length).toBe(1);
				expect(marked[0]).toContain("model-05");
				expect(text).toMatch(/more (above|below)/);
				expect(lines[lines.length - 1]).toStartWith("╰");
				await p.key("\r");
				expect(p.picked).toEqual(["model-05:latest"]);
			}
			p.stop();
		});
	}

	test("14 rows: the picker never leaves the model changed by a blind Enter", async () => {
		const p = await open(14);
		await p.key("\r");
		await p.key("\r");
		expect(p.picked).toEqual([]);
		p.stop();
	});

	test("the marked row is always on screen while moving down the whole list", async () => {
		const p = await open(17);
		for (let i = 0; i < MODELS.length + 2; i++) {
			await p.key("\u001B[B");
			const marked = p.frame().filter((l) => l.includes("❯"));
			expect(marked.length).toBe(1);
		}
		await p.key("\r");
		expect(p.picked).toEqual([MODELS[MODELS.length - 1]]);
		p.stop();
	});

	test("Esc closes and picks nothing, even when refusing", async () => {
		for (const rows of [14, 18]) {
			const p = await open(rows);
			await p.key("\u001B");
			expect(p.cancelled()).toBe(1);
			expect(p.picked).toEqual([]);
			p.stop();
		}
	});

	test("layout: refuses when one row plus the hint cannot fit, shows a row from there up", () => {
		expect(pickerLayout(14, MODELS.length, false, 8).refuse).toBe(true);
		expect(pickerLayout(10, MODELS.length, false, 8).refuse).toBe(true);
		for (let rows = 16; rows < 26; rows++) {
			const l = pickerLayout(rows, MODELS.length, false, 8);
			expect(l.refuse).toBe(false);
			expect(l.visible).toBeGreaterThanOrEqual(1);
		}
	});
});
