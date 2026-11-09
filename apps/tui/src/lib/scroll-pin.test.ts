import { describe, expect, test } from "bun:test";
import { offsetAfterNewMessages, pageMessages, pagingAction } from "./scroll-pin.js";

describe("pagingAction (break 9)", () => {
	test("plain PgUp and PgDn page the chat in every layout", () => {
		expect(pagingAction({ pageUp: true }, { approvalPending: false })).toEqual({ page: 1 });
		expect(pagingAction({ pageDown: true }, { approvalPending: false })).toEqual({ page: -1 });
	});

	test("a pending approval card owns plain PgUp and PgDn", () => {
		expect(pagingAction({ pageUp: true }, { approvalPending: true })).toBeNull();
		expect(pagingAction({ pageDown: true }, { approvalPending: true })).toBeNull();
	});

	test("shift paging still works while a card is pending", () => {
		expect(pagingAction({ pageUp: true, shift: true }, { approvalPending: true })).toEqual({
			page: 1,
		});
	});

	test("shift+arrows step one message; plain arrows are the input's", () => {
		expect(pagingAction({ shift: true, upArrow: true }, { approvalPending: false })).toEqual({
			step: 1,
		});
		expect(pagingAction({ shift: true, downArrow: true }, { approvalPending: false })).toEqual({
			step: -1,
		});
		expect(pagingAction({ upArrow: true }, { approvalPending: false })).toBeNull();
		expect(pagingAction({ downArrow: true }, { approvalPending: false })).toBeNull();
	});
});

describe("pageMessages: a page is rows, not a message count", () => {
	test("small messages: a page moves as many as fit the page rows", () => {
		const rows = Array(40).fill(2);
		expect(pageMessages({ rows, offset: 0, dir: 1, pageRows: 10 })).toBe(5);
		expect(pageMessages({ rows, offset: 10, dir: -1, pageRows: 10 })).toBe(-5);
	});

	test("one 44-line message moves alone, not with four more behind it", () => {
		const rows = [3, 3, 3, 3, 44, 3];
		// Bottom of the window is the 44-line message (offset 1): it pages as one.
		expect(pageMessages({ rows, offset: 1, dir: 1, pageRows: 18 })).toBe(1);
	});

	test("always moves at least one message, even when it is taller than a page", () => {
		expect(pageMessages({ rows: [100, 100], offset: 0, dir: 1, pageRows: 10 })).toBe(1);
	});

	test("does not run off the ends of the list", () => {
		expect(pageMessages({ rows: [2, 2], offset: 0, dir: 1, pageRows: 50 })).toBe(2);
		expect(pageMessages({ rows: [2, 2], offset: 0, dir: -1, pageRows: 50 })).toBe(-1);
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
