import { describe, expect, it } from "bun:test";
import { type ToolResult, normalizeToolResult } from "./tool-result";

describe("normalizeToolResult", () => {
	it("normalizes a plain string result", () => {
		const result = normalizeToolResult("myTool", "hello world");
		expect(result).toEqual({
			success: true,
			toolName: "myTool",
			result: "hello world",
		});
	});

	it("normalizes object with success/result fields, coercing result to string", () => {
		const result = normalizeToolResult("myTool", {
			success: true,
			result: 42,
		});
		expect(result.success).toBe(true);
		expect(result.toolName).toBe("myTool");
		expect(result.result).toBe("42");
	});

	it("passes through object with success/result when result is already a string", () => {
		const result = normalizeToolResult("myTool", {
			success: false,
			result: "partial output",
			error: "something broke",
		});
		expect(result.success).toBe(false);
		expect(result.result).toBe("partial output");
		expect(result.error).toBe("something broke");
	});

	it("normalizes an Error instance", () => {
		const err = new Error("connection timeout");
		const result = normalizeToolResult("netTool", err);
		expect(result.success).toBe(false);
		expect(result.toolName).toBe("netTool");
		expect(result.result).toBe("");
		expect(result.error).toBe("connection timeout");
	});

	it("normalizes null to success with empty result", () => {
		const result = normalizeToolResult("myTool", null);
		expect(result).toEqual({
			success: true,
			toolName: "myTool",
			result: "",
		});
	});

	it("normalizes undefined to success with empty result", () => {
		const result = normalizeToolResult("myTool", undefined);
		expect(result).toEqual({
			success: true,
			toolName: "myTool",
			result: "",
		});
	});

	it("normalizes object with .error field to failure", () => {
		const result = normalizeToolResult("apiTool", { error: "rate limited" });
		expect(result.success).toBe(false);
		expect(result.toolName).toBe("apiTool");
		expect(result.result).toBe("");
		expect(result.error).toBe("rate limited");
	});

	it("normalizes object with .message field to failure", () => {
		const result = normalizeToolResult("apiTool", {
			message: "not found",
		});
		expect(result.success).toBe(false);
		expect(result.toolName).toBe("apiTool");
		expect(result.result).toBe("");
		expect(result.error).toBe("not found");
	});

	it("stringifies complex objects to JSON", () => {
		const data = { items: [1, 2, 3], nested: { key: "value" } };
		const result = normalizeToolResult("dataTool", data);
		expect(result.success).toBe(true);
		expect(result.toolName).toBe("dataTool");
		expect(result.result).toBe(JSON.stringify(data));
	});

	it("attaches durationMs when provided", () => {
		const result = normalizeToolResult("myTool", "ok", 123);
		expect(result.success).toBe(true);
		expect(result.result).toBe("ok");
		expect(result.durationMs).toBe(123);
	});

	it("does not include durationMs when not provided", () => {
		const result = normalizeToolResult("myTool", "ok");
		expect(result.durationMs).toBeUndefined();
	});
});
