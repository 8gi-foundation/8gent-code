/** Settings at 40 columns: long field labels wrap whole, none ends in an ellipsis. */
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { render } from "ink";
import React from "react";
import { SettingsView } from "../SettingsView.js";

class In extends EventEmitter {
	isTTY = true;
	queue: string[] = [];
	press(k: string) {
		this.queue.push(k);
		this.emit("readable");
	}
	setRawMode() {}
	setEncoding() {}
	ref() {}
	unref() {}
	read() {
		return this.queue.shift() ?? null;
	}
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const strip = (s: string) => s.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");

async function frame(cols: number) {
	let last = "";
	const out = new Writable({
		write(c, _e, cb) {
			const s = c.toString();
			if (s.length > 20) last = s;
			cb();
		},
	}) as Writable & { columns: number; rows: number; isTTY: boolean };
	out.columns = cols;
	out.rows = 40;
	out.isTTY = true;
	const inst = render(<SettingsView visible={true} onClose={() => {}} />, {
		stdin: new In() as unknown as NodeJS.ReadStream,
		stdout: out as unknown as NodeJS.WriteStream,
		stderr: out as unknown as NodeJS.WriteStream,
		debug: true,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	await new Promise((r) => setTimeout(r, 200));
	inst.unmount();
	return strip(last);
}

test("40 columns: field labels wrap whole, no label ellipsis", async () => {
	const f = await frame(40);
	expect(f).toContain("threshold (ms)");
	expect(f).toContain("(fallback)");
	const labelRows = f.split("\n").filter((l) => !l.includes("───") && l.includes("…"));
	expect(labelRows).toEqual([]);
});

test("100 columns: labels stay on one row", async () => {
	const f = await frame(100);
	expect(f).toContain("Silence threshold (ms)");
	expect(f).toContain("TTS voice (fallback)");
});

test("40 columns: categories are one strip row, labels share a row with their value", async () => {
	const f = await frame(40);
	expect(f).toContain("Voice  1 of 7");
	expect(f).not.toContain("Categories");
	expect(f).toContain("Silence threshold (ms)");
	expect(f).toContain("TTS voice (fallback)");
});

test("100 columns: the category list stays a column", async () => {
	const f = await frame(100);
	expect(f).toContain("Categories");
	expect(f).not.toContain("1 of 7");
});

test("40 columns: Tab advances from categories that have no fields", async () => {
	let last = "";
	const out = new Writable({
		write(c, _e, cb) {
			const s = c.toString();
			if (s.length > 20) last = s;
			cb();
		},
	}) as Writable & { columns: number; rows: number; isTTY: boolean };
	out.columns = 40;
	out.rows = 40;
	out.isTTY = true;
	const stdin = new In();
	const inst = render(<SettingsView visible={true} onClose={() => {}} />, {
		stdin: stdin as unknown as NodeJS.ReadStream,
		stdout: out as unknown as NodeJS.WriteStream,
		stderr: out as unknown as NodeJS.WriteStream,
		debug: true,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	const tab = async () => {
		stdin.press("\t");
		await new Promise((r) => setTimeout(r, 60));
	};
	await new Promise((r) => setTimeout(r, 100));
	for (let i = 0; i < 5; i++) await tab();
	expect(strip(last)).toContain("Context windows  6 of 7");
	await tab();
	expect(strip(last)).toContain("Keys  7 of 7");
	await tab();
	expect(strip(last)).toContain("Voice  1 of 7");
	inst.unmount();
});

test("40 columns: fits 24 rows, heading on one line, rule not cut", async () => {
	const f = await frame(40);
	const rows = f.split("\n");
	expect(rows.length).toBeLessThanOrEqual(24);
	expect(rows.some((l) => l.includes("Settings") && l.includes("categories"))).toBe(true);
	expect(rows.filter((l) => l.includes("───") && l.includes("…"))).toEqual([]);
});
