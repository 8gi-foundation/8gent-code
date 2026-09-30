/**
 * TurnResults through real Ink: the finished turn's rows, how they land when
 * the reply arrives, and the fallbacks (animations off, ASCII terminals).
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { render, renderToString } from "ink";
import { MOTION_BUDGET_MS, SETTLE_HOLD_MS } from "../../lib/motion.js";
import type { ToolTrailEntry } from "../../lib/tool-trail.js";
import { TurnResults } from "../TurnResults.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

const trail: ToolTrailEntry[] = [
	{
		tool: "update_plan",
		summary: "",
		status: "ok",
		plan: [
			{ step: "Find the off-by-one in paginate", status: "completed" },
			{ step: "Fix it and rerun the tests", status: "completed" },
		],
	},
	{ tool: "read_file", summary: "src/paginate.ts", status: "ok" },
	{ tool: "read_file", summary: "src/paginate.test.ts", status: "ok" },
	{ tool: "run_command", summary: "bun test", status: "fail", reason: "exit 1" },
	{ tool: "edit_file", summary: "src/paginate.ts", status: "ok" },
	{ tool: "run_command", summary: "bun test", status: "ok" },
];

function mount(node: React.ReactElement, cols = 80) {
	const out = new EventEmitter() as EventEmitter & {
		columns: number;
		rows: number;
		isTTY: boolean;
		frames: string[];
		write: (s: string) => boolean;
	};
	out.columns = cols;
	out.rows = 24;
	out.isTTY = false;
	out.frames = [];
	out.write = (s: string) => {
		out.frames.push(strip(s));
		return true;
	};
	const app = render(node, {
		stdout: out as unknown as NodeJS.WriteStream,
		debug: true,
		patchConsole: false,
		exitOnCtrlC: false,
	});
	return { app, last: () => out.frames.at(-1) ?? "" };
}

const count = (frame: string, glyph: string) => frame.split("\n").filter((l) => l.includes(glyph)).length;

describe("TurnResults", () => {
	test("plan steps, then what the calls did, each on one row", () => {
		const out = renderToString(<TurnResults trail={trail} width={70} animate={false} />, { columns: 80 });
		const ls = out.split("\n");
		expect(ls[0]).toBe("✓ Find the off-by-one in paginate");
		expect(ls[1]).toBe("✓ Fix it and rerun the tests");
		expect(ls[2]).toContain("✓ Read  src/  2 files");
		expect(ls[3]).toContain("✗ Ran  bun test");
		expect(ls[3]).toContain("exit 1");
		expect(ls[4]).toContain("✓ Edited  src/paginate.ts");
		expect(ls[5]).toContain("✓ Ran  bun test");
		for (const l of ls) expect(l.length).toBeLessThanOrEqual(70);
	});

	test("a new result lands after the DONE settle, row by row, within the motion budget", async () => {
		const { app, last } = mount(<TurnResults trail={trail} width={70} land animate />);
		await sleep(40);
		// Still settling: the block holds its height, no row drawn yet.
		expect(count(last(), "✓") + count(last(), "✗")).toBe(0);
		await sleep(SETTLE_HOLD_MS + 60);
		const mid = count(last(), "✓") + count(last(), "✗");
		expect(mid).toBeGreaterThan(0);
		expect(mid).toBeLessThan(6);
		await sleep(MOTION_BUDGET_MS + 60);
		expect(count(last(), "✓") + count(last(), "✗")).toBe(6);
		app.unmount();
	});

	test("animations off (Ctrl+A) draws every row at once", async () => {
		const { app, last } = mount(<TurnResults trail={trail} width={70} land animate={false} />);
		await sleep(20);
		expect(count(last(), "✓") + count(last(), "✗")).toBe(6);
		app.unmount();
	});

	test("8GENT_REDUCED_MOTION=1 draws every row at once", async () => {
		const prev = process.env["8GENT_REDUCED_MOTION"];
		process.env["8GENT_REDUCED_MOTION"] = "1";
		try {
			const { app, last } = mount(<TurnResults trail={trail} width={70} land animate />);
			await sleep(20);
			expect(count(last(), "✓") + count(last(), "✗")).toBe(6);
			app.unmount();
		} finally {
			if (prev === undefined) delete process.env["8GENT_REDUCED_MOTION"];
			else process.env["8GENT_REDUCED_MOTION"] = prev;
		}
	});

	test("EIGHT_ASCII=1 swaps the icons for ASCII", () => {
		const prev = process.env.EIGHT_ASCII;
		process.env.EIGHT_ASCII = "1";
		try {
			const out = renderToString(<TurnResults trail={trail} width={70} animate={false} />, { columns: 80 });
			expect(out).not.toMatch(/[✓✗⊘○]/);
			expect(out).toContain("+ Find the off-by-one");
			expect(out).toContain("x Ran  bun test");
		} finally {
			if (prev === undefined) delete process.env.EIGHT_ASCII;
			else process.env.EIGHT_ASCII = prev;
		}
	});
});
