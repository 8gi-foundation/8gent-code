/**
 * Inline markdown in chat replies (audit #6, g5-raw-markdown-a011.png).
 * Renders a real reply through MessageList at 80 columns: no raw ** or
 * backticks, lists hang, code keeps its indent, nothing passes column 80,
 * and the row estimate the chat budget uses matches what Ink draws.
 */

import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import type { Message } from "../../app.js";
import { bubbleWidths } from "../../lib/chat-layout.js";
import { MessageList, estimateMessageRowsForTest } from "../message-list.js";

const at = new Date("2026-09-30T02:53:00Z");
const COLS = 80;

const reply =
	"**Run the suite with `bun test`** from the package root.\n\n" +
	"- Read `package.json` to find the `scripts.test` entry and the test runner the package really uses.\n" +
	"- List where tests live, e.g. `src/**/*.test.ts` and `__tests__/`\n" +
	"  - nested: *only* when the runner needs it\n" +
	"1. Numbered steps keep their numbers\n\n" +
	"```ts\nfunction paginate(items: number[], page: number) {\n  return items.slice(page * 10, page * 10 + 10);\n}\n```\n" +
	"Done.";

function renderReply(content: string, width = COLS): string[] {
	const messages: Message[] = [{ id: "a1", role: "assistant", content, timestamp: at }];
	const out = renderToString(
		<MessageList messages={messages} contentWidth={width} animateTyping={false} showAnimations={false} turnRunning={false} rowBudget={200} />,
		{ columns: width },
	);
	return out.split("\n");
}

describe("chat markdown at 80 columns", () => {
	const lines = renderReply(reply);
	const text = lines.join("\n");

	test("no raw markers reach the screen", () => {
		// "**" survives only inside the chip, where the reply meant it literally.
		expect(text.replace(" src/**/*.test.ts ", "")).not.toContain("**");
		expect(text).not.toContain("`");
		expect(text).toContain(" src/**/*.test.ts ");
		expect(text).toContain("Run the suite with  bun test ");
		expect(text).toContain("only when the runner needs it");
	});

	test("list items hang: continuation lines start under the text, not the bullet", () => {
		const first = lines.findIndex((l) => l.includes("• Read"));
		expect(first).toBeGreaterThan(-1);
		const bulletCol = lines[first].indexOf("•");
		const cont = lines[first + 1];
		expect(cont.slice(0, bulletCol + 2).trim().replace(/[│|]/g, "")).toBe("");
		expect(cont[bulletCol + 2]).not.toBe(" ");
		expect(text).toContain("1. Numbered steps");
		// The nested item sits two columns further in.
		const nested = lines.find((l) => l.includes("nested:")) ?? "";
		expect(nested.indexOf("•")).toBe(bulletCol + 2);
	});

	test("code keeps its indentation behind a thin rule", () => {
		expect(lines.some((l) => /│ {3}return items\.slice/.test(l))).toBe(true);
		expect(text).not.toContain("╭");
	});

	test("nothing passes column 80", () => {
		for (const l of lines) expect([...l].length).toBeLessThanOrEqual(COLS);
	});

	test("the row estimate matches the drawn rows", () => {
		for (const width of [40, 60, 76, 120]) {
			const drawn = renderReply(reply, width);
			while (drawn.length && drawn[drawn.length - 1].trim() === "") drawn.pop();
			const wrap = bubbleWidths(width, "assistant").wrap;
			const est = estimateMessageRowsForTest(
				{ id: "a1", role: "assistant", content: reply, timestamp: at },
				wrap,
			);
			// The estimate includes the one-row gap under the bubble.
			expect(drawn.length).toBe(est - 1);
		}
	});
});
