/** Settings at 40 columns: long field labels wrap whole, none ends in an ellipsis. */
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { render } from "ink";
import React from "react";
import { SettingsView } from "../SettingsView.js";

class In extends EventEmitter {
	isTTY = true;
	setRawMode() {}
	setEncoding() {}
	ref() {}
	unref() {}
	read() {
		return null;
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
