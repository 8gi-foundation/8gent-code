/**
 * Tool output under its row (#4954), rendered through Ink at the two widths that matter: 100
 * columns (a Mac) and 52 (a phone in Termux). A failure shows its tail by default; a success
 * shows nothing until it is opened (the store Ctrl+O, a tap and /out all flip).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import type { Message } from "../../app.js";
import {
	isOutputExpanded,
	outputClickSpans,
	resetToolOutputForTests,
	rowOutput,
	toggleOutput,
} from "../../lib/tool-output-state.js";
import { type ToolTrailEntry, toTrailEntry } from "../../lib/tool-trail.js";
import { ToolTrail } from "../ToolTrail.js";
import { TurnResults } from "../TurnResults.js";
import { MessageList, estimateMessageRowsForTest } from "../message-list.js";

afterEach(() => resetToolOutputForTests());

const at = new Date("2026-10-24T15:00:00Z");
const render = (node: React.ReactElement, columns: number) => renderToString(node, { columns });

const stdout = Array.from({ length: 80 }, (_, i) => `pass test-${i + 1}`).join("\n");
const failOutput = `Exit code 1:\n${stdout}\n1 fail  packages/decide/score.test.ts\nexpected 3 received 2   (tie-break)\n  at score.test.ts:41`;

const failing = (): ToolTrailEntry =>
	toTrailEntry({
		toolName: "run_command",
		args: { command: "bun test packages/decide" },
		success: true,
		resultPreview: failOutput.slice(0, 200),
		resultFull: failOutput,
	});
const succeeding = (): ToolTrailEntry =>
	toTrailEntry({
		toolName: "run_command",
		args: { command: "ls deck" },
		success: true,
		resultPreview: "a.md\nb.md",
		resultFull: Array.from({ length: 12 }, (_, i) => `file-${i + 1}.md`).join("\n"),
	});

for (const width of [100, 52]) {
	describe(`finished turn at ${width} columns`, () => {
		const w = width - 8;

		test("a failed run shows exit code, the stderr tail, and how many more lines", () => {
			const e = failing();
			const out = render(<TurnResults trail={[e]} width={w} animate={false} />, width);
			expect(out).toContain("exit 1");
			expect(out).toContain("expected 3 received 2");
			expect(out).toContain("at score.test.ts:41");
			expect(out).not.toContain("pass test-1\n");
			expect(out).toMatch(/\d+ more/);
			expect(out).toContain(`/out ${e.seq}`);
			for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(width);
		});

		test("a success shows only its row until it is opened", () => {
			const e = succeeding();
			const closed = render(<TurnResults trail={[e]} width={w} animate={false} />, width);
			expect(closed).not.toContain("file-1.md");
			toggleOutput(e.seq as number);
			const open = render(<TurnResults trail={[e]} width={w} animate={false} />, width);
			expect(open).toContain("file-1.md");
			expect(open).toContain("file-12.md");
			expect(open).toMatch(/collapse|close/);
		});

		test("opening a failure shows the head and the tail, not the middle", () => {
			const e = failing();
			toggleOutput(e.seq as number);
			const out = render(<TurnResults trail={[e]} width={w} animate={false} />, width);
			expect(out).toContain("pass test-1");
			expect(out).toContain("pass test-40");
			expect(out).toContain("lines not shown");
			expect(out).toContain("at score.test.ts:41");
		});

		test("the live trail shows the same block", () => {
			const e = failing();
			const out = render(<ToolTrail entries={[e]} width={w} animate={false} />, width);
			expect(out).toContain("expected 3 received 2");
			expect(out).toMatch(/\d+ more/);
			for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(width);
		});

		test("a call that kept no output draws exactly the row it drew before", () => {
			const e: ToolTrailEntry = { tool: "write_file", summary: "a.md", status: "ok" };
			const out = render(<TurnResults trail={[e]} width={w} animate={false} />, width);
			expect(out.trim().split("\n")).toHaveLength(1);
		});
	});
}

describe("rowOutput and the tap target", () => {
	test("the tap covers the row and its output lines, and flips that call", () => {
		const e = failing();
		const row = { status: "fail" as const, seq: e.seq, output: e.output };
		const r = rowOutput(row, 92);
		expect(r.extraRows).toBe(r.view.lines.length + (r.view.hint ? 1 : 0));
		const spans = outputClickSpans(row, 92);
		expect(spans).toHaveLength(1);
		expect(spans[0]).toMatchObject({ dx: 0, w: 92, h: 1 + r.extraRows });
		expect(isOutputExpanded(e.seq as number)).toBe(false);
		spans[0].action();
		expect(isOutputExpanded(e.seq as number)).toBe(true);
		spans[0].action();
		expect(isOutputExpanded(e.seq as number)).toBe(false);
	});
	test("a row with no output has no tap target and no extra rows", () => {
		const row = { status: "ok" as const };
		expect(outputClickSpans(row, 92)).toEqual([]);
		expect(rowOutput(row, 92).extraRows).toBe(0);
	});
});

describe("in the message list", () => {
	const turn = (): Message[] => {
		const e = failing();
		return [
			{ id: "u1", role: "user", content: "run the tests", timestamp: at },
			{ id: "t1", role: "tool", content: "  ✗", timestamp: at, toolTrail: e },
			{ id: "a1", role: "assistant", content: "One test fails.", timestamp: at },
		];
	};

	for (const width of [100, 52]) {
		test(`the reply's results carry the failure tail at ${width} columns`, () => {
			const out = render(
				<MessageList
					messages={turn()}
					animateTyping={false}
					showAnimations={false}
					turnRunning={false}
					contentWidth={width - 8}
					rowBudget={60}
				/>,
				width,
			);
			expect(out).toContain("exit 1");
			expect(out).toContain("expected 3 received 2");
			expect(out).toContain("One test fails.");
		});
	}

	test("the row estimate counts the output lines, so the window clips right", () => {
		const e = failing();
		const msg: Message = { id: "a1", role: "assistant", content: "x", timestamp: at };
		const without = estimateMessageRowsForTest(msg, 80, []);
		const closed = estimateMessageRowsForTest(msg, 80, [e]);
		toggleOutput(e.seq as number);
		const open = estimateMessageRowsForTest(msg, 80, [e]);
		expect(closed).toBeGreaterThan(without + 10);
		expect(open).toBeGreaterThan(closed);
	});
});
