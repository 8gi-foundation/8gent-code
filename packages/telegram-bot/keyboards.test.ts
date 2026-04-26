import { describe, expect, it } from "bun:test";
import {
	CB_PREFIX,
	approvalKeyboard,
	parseCallbackData,
	safeData,
	taskCompleteKeyboard,
	taskFailedKeyboard,
	taskRunningKeyboard,
} from "./keyboards";

describe("safeData", () => {
	it("encodes prefix:payload under 64 bytes", () => {
		expect(safeData("tx", "abc")).toBe("tx:abc");
	});

	it("truncates long payloads", () => {
		const long = "a".repeat(500);
		const data = safeData("tx", long);
		expect(Buffer.byteLength(data, "utf-8")).toBeLessThanOrEqual(64);
		expect(data.startsWith("tx:")).toBe(true);
	});

	it("round-trips through parseCallbackData", () => {
		const data = safeData(CB_PREFIX.taskCancel, "task_xyz");
		const parsed = parseCallbackData(data);
		expect(parsed.prefix).toBe(CB_PREFIX.taskCancel);
		expect(parsed.payload).toBe("task_xyz");
	});

	it("handles prefix-only data", () => {
		expect(parseCallbackData("noop")).toEqual({ prefix: "noop", payload: "" });
	});
});

describe("keyboards", () => {
	it("running keyboard exposes Cancel", () => {
		const kb = taskRunningKeyboard("task_a");
		expect(kb.inline_keyboard[0][0].text).toContain("Cancel");
		expect(kb.inline_keyboard[0][0].callback_data).toBe("tx:task_a");
	});

	it("complete keyboard adds resend row when files queued", () => {
		const kb = taskCompleteKeyboard("task_b", true);
		expect(kb.inline_keyboard.length).toBe(2);
		expect(kb.inline_keyboard[1][0].text).toContain("Resend");
	});

	it("failed keyboard offers Retry and Drop", () => {
		const kb = taskFailedKeyboard("task_c");
		const labels = kb.inline_keyboard[0].map((b) => b.text);
		expect(labels.some((l) => l.includes("Retry"))).toBe(true);
		expect(labels.some((l) => l.includes("Drop"))).toBe(true);
	});

	it("approval keyboard pairs approve/deny callbacks", () => {
		const kb = approvalKeyboard("req_42");
		const cbs = kb.inline_keyboard[0].map((b) => b.callback_data);
		expect(cbs).toEqual(["ok:req_42", "no:req_42"]);
	});
});
