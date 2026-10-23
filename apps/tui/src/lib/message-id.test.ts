import { expect, test } from "bun:test";
import { messageId } from "./message-id.js";

test("two ids made in the same millisecond differ", () => {
	const realNow = Date.now;
	Date.now = () => 1_700_000_000_000;
	try {
		const ids = Array.from({ length: 50 }, () => messageId("system"));
		expect(new Set(ids).size).toBe(50);
	} finally {
		Date.now = realNow;
	}
});

test("the prefix is kept, so prefix checks on an id still match", () => {
	expect(messageId("setup-q").startsWith("setup-q-")).toBe(true);
	expect(messageId("system")).toMatch(/^system-\d+-\d+$/);
});
