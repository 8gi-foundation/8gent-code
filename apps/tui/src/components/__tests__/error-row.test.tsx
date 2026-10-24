/**
 * Errors drawn as errors (#4955), rendered through Ink at 100 and 52 columns: a distinct row with
 * kind, cause, retry count and next step; a retry or loop guard as one `!` line, in turn order.
 */

import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import type { Message } from "../../app.js";
import { errorNotice, guardNoticeOf, retryNoticeOf } from "../../lib/error-row.js";
import { MessageList, estimateMessageRowsForTest } from "../message-list.js";

const at = new Date("2026-10-24T15:00:00Z");
const render = (messages: Message[], columns: number) =>
	renderToString(
		<MessageList
			messages={messages}
			animateTyping={false}
			showAnimations={false}
			turnRunning={false}
			contentWidth={columns - 8}
			rowBudget={40}
		/>,
		{ columns },
	);

const turn = (): Message[] => [
	{ id: "u1", role: "user", content: "fix the tie-break", timestamp: at },
	{
		id: "n1",
		role: "system",
		content: "! retry 1/3 in 2s: 429 Too Many Requests",
		timestamp: at,
		notice: retryNoticeOf({
			kind: "rate_limit",
			provider: "openrouter",
			model: "m",
			attempt: 1,
			max: 3,
			cause: "429 Too Many Requests",
			delayMs: 2000,
		}),
	},
	{
		id: "n2",
		role: "system",
		content: "! stopped",
		timestamp: at,
		notice: guardNoticeOf({
			kind: "circuit_breaker",
			reason: "I made the same read_file call 3 times in a row, so I stopped to avoid a loop.",
		}),
	},
	{
		id: "assistant-error-1",
		role: "assistant",
		content: "[Error] provider timeout after 60s",
		timestamp: at,
		notice: errorNotice("provider timeout after 60s", 3),
	},
];

for (const width of [100, 52]) {
	describe(`at ${width} columns`, () => {
		test("the error is a row with kind, cause, retry count and next step", () => {
			const out = render(turn(), width);
			expect(out).toContain("✗ timeout");
			expect(out).toContain("provider timeout after 60s");
			expect(out).toMatch(/retry 3( of |\/)3/);
			expect(out).toContain("next: send again, or /provider");
			expect(out).not.toContain("[Error]");
		});

		test("retries and loop guards are one line each, in turn order", () => {
			const out = render(turn(), width);
			const i1 = out.indexOf("! retry 1/3 in 2s");
			const i2 = out.indexOf("! stopped:");
			const i3 = out.indexOf("✗ timeout");
			expect(i1).toBeGreaterThan(-1);
			expect(i2).toBeGreaterThan(i1);
			expect(i3).toBeGreaterThan(i2);
		});

		test("consecutive retry notices sit on consecutive lines", () => {
			const lines = render(turn(), width).split("\n");
			const at1 = lines.findIndex((l) => l.includes("! retry 1/3"));
			expect(lines[at1 + 1]).toContain("! stopped:");
		});

		test("nothing is wider than the screen", () => {
			for (const line of render(turn(), width).split("\n"))
				expect(line.length).toBeLessThanOrEqual(width);
		});
	});
}

describe("row estimate", () => {
	test("an error takes its lines plus one blank row, a one-line notice just its line", () => {
		const warn: Message = {
			id: "w",
			role: "system",
			content: "x",
			timestamp: at,
			notice: guardNoticeOf({ kind: "loop_nudge", reason: "again" }),
		};
		const err: Message = {
			id: "e",
			role: "assistant",
			content: "x",
			timestamp: at,
			notice: errorNotice("fetch failed", 0),
		};
		// A one-line retry or guard notice has no blank row after it: several in a row stay tight.
		expect(estimateMessageRowsForTest(warn, 80)).toBe(1);
		expect(estimateMessageRowsForTest(err, 80)).toBe(3);
	});
});
