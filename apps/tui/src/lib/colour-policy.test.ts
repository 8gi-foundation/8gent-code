import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { colourPolicy, installColourPolicy, stripColourSgr } from "./colour-policy.js";

const ESC = "\x1b[";
/** SGR sequences in `s` that still set a colour. */
function colourSgr(s: string): string[] {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR needs the escape byte
	return [...s.matchAll(/\x1b\[([0-9;:]*)m/g)]
		.map((m) => m[1])
		.filter((p) =>
			p.split(";").some((t) => /^(3\d|4\d|9[0-7]|10[0-7]|5[89])$/.test(t.split(":")[0])),
		);
}

describe("colourPolicy precedence (#3171)", () => {
	test("FORCE_COLOR set wins, then NO_COLOR, then TERM=dumb, else auto", () => {
		expect(colourPolicy({ TERM: "xterm-256color" })).toBe("auto");
		expect(colourPolicy({ NO_COLOR: "1" })).toBe("none");
		expect(colourPolicy({ NO_COLOR: "" })).toBe("auto");
		expect(colourPolicy({ TERM: "dumb" })).toBe("none");
		expect(colourPolicy({ NO_COLOR: "1", FORCE_COLOR: "3" })).toBe("forced");
		expect(colourPolicy({ TERM: "dumb", FORCE_COLOR: "" })).toBe("forced");
		expect(colourPolicy({ FORCE_COLOR: "0" })).toBe("none");
	});
});

describe("stripColourSgr keeps styles, drops colour", () => {
	test("truecolour, 256, 16 and bright colours all go", () => {
		const s = `${ESC}38;2;232;97;10mA${ESC}39m ${ESC}48;5;236mB${ESC}49m ${ESC}31mC${ESC}39m ${ESC}91;104mD${ESC}0m`;
		const out = stripColourSgr(s);
		expect(colourSgr(out)).toEqual([]);
		expect(out).toBe(`A B C D${ESC}0m`);
	});

	test("bold, dim, inverse and their resets survive, even mixed with colour", () => {
		const s = `${ESC}1;38;2;1;2;3mA${ESC}22;39m${ESC}7mB${ESC}27m${ESC}2mC${ESC}22m`;
		expect(stripColourSgr(s)).toBe(`${ESC}1mA${ESC}22m${ESC}7mB${ESC}27m${ESC}2mC${ESC}22m`);
	});

	test("a bare reset stays a reset; a sequence emptied of colour is dropped whole", () => {
		expect(stripColourSgr(`${ESC}mX`)).toBe(`${ESC}mX`);
		expect(stripColourSgr(`${ESC}38:2::9:9:9mX`)).toBe("X");
	});

	test("cursor moves and other CSI sequences are untouched", () => {
		const s = `${ESC}2K${ESC}1A${ESC}?25l${ESC}G`;
		expect(stripColourSgr(s)).toBe(s);
	});
});

describe("installColourPolicy wraps the stream only when colour is off", () => {
	test("NO_COLOR strips string writes and passes buffers through", () => {
		const seen: unknown[] = [];
		const stream = {
			write: (chunk: unknown) => {
				seen.push(chunk);
				return true;
			},
		};
		expect(installColourPolicy(stream, { NO_COLOR: "1" })).toBe(true);
		stream.write(`${ESC}31mred${ESC}39m` as never);
		const buf = Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d]);
		stream.write(buf as never);
		expect(seen).toEqual(["red", buf]);
	});

	test("with colour on the stream is left alone", () => {
		const stream = { write: (_: unknown) => true };
		const before = stream.write;
		expect(installColourPolicy(stream, { TERM: "xterm-256color" })).toBe(false);
		expect(installColourPolicy(stream, { NO_COLOR: "1", FORCE_COLOR: "3" })).toBe(false);
		expect(stream.write).toBe(before);
	});
});

describe("real Ink frame, real chalk (#3171)", () => {
	// Chalk inside Ink never reads NO_COLOR, so a child with FORCE_COLOR=3 is
	// the stand-in for a truecolour TTY with NO_COLOR=1: without the policy the
	// frame carries colour, with it the frame carries none but keeps inverse.
	const script = (install: boolean) => `
		import React from "react";
		import { render, Text, Box } from "ink";
		import { installColourPolicy } from ${JSON.stringify(join(import.meta.dir, "colour-policy.ts"))};
		if (${install}) installColourPolicy(process.stdout, { NO_COLOR: "1" });
		const h = React.createElement;
		const app = render(h(Box, null,
			h(Text, { color: "#E5503A", bold: true }, "risk HIGH "),
			h(Text, { backgroundColor: "#2E2A26" }, "chip "),
			h(Text, { inverse: true }, " ")));
		app.unmount();
	`;
	const run = (install: boolean) => {
		const r = Bun.spawnSync(["bun", "-e", script(install)], {
			cwd: join(import.meta.dir, "..", ".."),
			env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", FORCE_COLOR: "3" },
		});
		return r.stdout.toString();
	};

	test("without the policy the frame is coloured (the bug)", () => {
		expect(colourSgr(run(false)).length).toBeGreaterThan(0);
	});

	test("with NO_COLOR the frame has no colour and keeps bold and inverse", () => {
		const out = run(true);
		expect(out).toContain("risk HIGH");
		expect(colourSgr(out)).toEqual([]);
		expect(out).toContain(`${ESC}1m`);
		expect(out).toContain(`${ESC}7m`);
	});
});
