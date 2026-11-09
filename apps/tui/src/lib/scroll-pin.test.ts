import { describe, expect, test } from "bun:test";
import { PAGE_MESSAGES, offsetAfterNewMessages, pagingDelta } from "./scroll-pin.js";

describe("pagingDelta (break 9)", () => {
	test("plain PgUp and PgDn page the chat in every layout", () => {
		expect(pagingDelta({ pageUp: true }, { approvalPending: false })).toBe(PAGE_MESSAGES);
		expect(pagingDelta({ pageDown: true }, { approvalPending: false })).toBe(-PAGE_MESSAGES);
	});

	test("PgDn is the exact inverse of PgUp", () => {
		const up = pagingDelta({ pageUp: true }, { approvalPending: false }) as number;
		const down = pagingDelta({ pageDown: true }, { approvalPending: false }) as number;
		expect(up + down).toBe(0);
	});

	test("a pending approval card owns plain PgUp and PgDn", () => {
		expect(pagingDelta({ pageUp: true }, { approvalPending: true })).toBeNull();
		expect(pagingDelta({ pageDown: true }, { approvalPending: true })).toBeNull();
	});

	test("shift paging still works while a card is pending", () => {
		expect(pagingDelta({ pageUp: true, shift: true }, { approvalPending: true })).toBe(PAGE_MESSAGES);
	});

	test("shift+arrows step one message; plain arrows are the input's", () => {
		expect(pagingDelta({ shift: true, upArrow: true }, { approvalPending: false })).toBe(1);
		expect(pagingDelta({ shift: true, downArrow: true }, { approvalPending: false })).toBe(-1);
		expect(pagingDelta({ upArrow: true }, { approvalPending: false })).toBeNull();
		expect(pagingDelta({ downArrow: true }, { approvalPending: false })).toBeNull();
	});
});

describe("offsetAfterNewMessages (break 8)", () => {
	test("sending a message snaps a scrolled-up chat to the bottom", () => {
		const r = offsetAfterNewMessages({
			offset: 12,
			pinned: false,
			added: [{ role: "user" }],
			total: 60,
		});
		expect(r).toEqual({ offset: 0, pinned: true });
	});

	test("a user message among several new ones still snaps", () => {
		const r = offsetAfterNewMessages({
			offset: 4,
			pinned: false,
			added: [{ role: "assistant" }, { role: "user" }],
			total: 20,
		});
		expect(r).toEqual({ offset: 0, pinned: true });
	});

	test("a reply while scrolled up stays locked on what the person is reading", () => {
		const r = offsetAfterNewMessages({
			offset: 3,
			pinned: false,
			added: [{ role: "assistant" }, { role: "tool" }],
			total: 30,
		});
		expect(r).toEqual({ offset: 5, pinned: false });
	});

	test("the offset never passes the oldest message", () => {
		const r = offsetAfterNewMessages({
			offset: 9,
			pinned: false,
			added: [{ role: "assistant" }, { role: "assistant" }],
			total: 10,
		});
		expect(r.offset).toBe(9);
	});

	test("a pinned chat follows the live edge", () => {
		const r = offsetAfterNewMessages({
			offset: 0,
			pinned: true,
			added: [{ role: "assistant" }],
			total: 5,
		});
		expect(r).toEqual({ offset: 0, pinned: true });
	});
});
