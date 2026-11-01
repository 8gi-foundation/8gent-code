import { describe, expect, test } from "bun:test";
import { footerRidesSenderRow, replyFooter } from "../../lib/chat-layout.js";
import { estimateMessageRowsForTest } from "../message-list.js";

const at = new Date("2026-09-29T16:21:00Z");
const reply = {
	id: "a",
	role: "assistant" as const,
	content: "Done.",
	timestamp: at,
	tokens: 88,
	latencyMs: 900,
};

describe("reply footer on narrow columns", () => {
	test("formats latency and tokens", () => {
		expect(replyFooter(3200, 412)).toBe("3.2s · 412 tok");
		expect(replyFooter(900, 88)).toBe("900ms · 88 tok");
	});
	test("rides the sender row at 40 columns, not at 100", () => {
		expect(footerRidesSenderRow(36, replyFooter(3200, 412))).toBe(true);
		expect(footerRidesSenderRow(96, replyFooter(3200, 412))).toBe(false);
	});
	test("a footer too wide for the row keeps its own row", () => {
		expect(footerRidesSenderRow(24, replyFooter(3200, 412))).toBe(false);
	});
	test("row estimate drops one row at 40, unchanged at 100", () => {
		expect(estimateMessageRowsForTest(reply, 36)).toBe(3);
		expect(estimateMessageRowsForTest(reply, 96)).toBe(4);
	});
});
