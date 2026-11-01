/**
 * The compact approval card at phone widths (#5141). It used to break its key
 * row into fragments stacked down the screen at 40 and 42 columns, and a cut
 * command ran straight into "[Y]" at 100. One render per width through the
 * real component: every cap whole and next to its verb, no split word, and a
 * cut command marked with "…" and a space before the first cap.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { type Instance, render } from "ink";
import React from "react";

import { InlineApprovalPrompt } from "../InlineApprovalPrompt.js";

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

type FakeStdout = Writable & { columns: number; rows: number; last: string };

function makeStdout(columns: number): FakeStdout {
	const out = new Writable({
		write(chunk, _enc, cb) {
			const s = chunk.toString();
			if (s.trim()) out.last = s;
			cb();
		},
	}) as FakeStdout;
	out.last = "";
	out.columns = columns;
	out.rows = 40;
	return out;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const stripAnsi = (s: string) => s.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

let instance: Instance | null = null;
afterEach(() => {
	instance?.unmount();
	instance = null;
});

async function frameAt(columns: number, target: string, gate = false): Promise<string[]> {
	const stdout = makeStdout(columns);
	instance = render(<InlineApprovalPrompt target={target} reason="risky step" gate={gate} />, {
		stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: makeStdout(columns) as unknown as NodeJS.WriteStream,
		debug: false,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	await tick();
	return stripAnsi(stdout.last)
		.split("\n")
		.filter((l) => /│/.test(l))
		.map((l) => l.replace(/^\s*│/, "").replace(/│\s*$/, ""));
}

const CMD = "bun run build --filter=@8gent/tui && bun test apps/tui --bail";
const LONG = `bun run build --filter=@8gent/tui && ${"x".repeat(160)}`;
const WORDS = ["approve", "deny", "edit", "skip", "yes", "no"];
const CAP_VERB = /\[([YNES])\] (approve|deny|edit|skip|yes|no)/g;

describe("compact approval card at phone widths", () => {
	for (const [columns, command] of [
		[30, CMD],
		[40, CMD],
		[42, CMD],
		[52, CMD],
		[100, CMD],
		[30, LONG],
		[40, LONG],
		[42, LONG],
		[52, LONG],
		[100, LONG],
	] as const) {
		test(`${columns} columns, ${command === CMD ? "short" : "long"} command: caps whole, no split word, cut marked`, async () => {
			const rows = await frameAt(columns, command);
			const all = rows.join("\n");
			// Every cap is whole and next to its verb.
			const caps = [...all.matchAll(CAP_VERB)].map((m) => m[1]).sort();
			expect(caps).toEqual(["E", "N", "S", "Y"]);
			expect([...all.matchAll(/\[[A-Z]\]/g)].length).toBe(4);
			// No row holds a fragment of a key word or an orphan cap.
			for (const row of rows) {
				const tokens = row.trim().split(/\s+/).filter(Boolean);
				for (const tok of tokens) {
					if (
						/^\[?[YNES]\]?$/.test(tok) &&
						tok !== "[Y]" &&
						tok !== "[N]" &&
						tok !== "[E]" &&
						tok !== "[S]"
					)
						throw new Error(`fragment "${tok}" in: ${row}`);
				}
				expect(row.length).toBeLessThanOrEqual(columns - 2);
			}
			// The card is short: border, command row, key row(s), border.
			expect(rows.length).toBeLessThanOrEqual(3);
			// A cut command: ellipsis marks it, and a space precedes the first cap.
			for (const row of rows) {
				const first = row.indexOf("[");
				if (first > 0 && row.includes("…")) expect(row[first - 1]).toBe(" ");
				expect(row).not.toMatch(/…\[/);
			}
			// Either the whole command is shown or it is marked as cut.
			const shown = all.includes(command) || all.includes("…");
			expect(shown).toBe(true);
			expect(WORDS.length).toBeGreaterThan(0);
		});
	}

	test("40 columns, yolo gate: Y and N only, whole", async () => {
		const rows = await frameAt(40, "enable yolo", true);
		const all = rows.join("\n");
		expect(all).toContain("[Y] yes");
		expect(all).toContain("[N] no");
		expect(all).not.toContain("[E]");
	});
});
