import { describe, expect, test } from "bun:test";
import { createWaitNoticeGate, waitNotice } from "./wait-notice.js";

describe("waitNotice", () => {
	test("names the busy model and the wait, in plain words", () => {
		const line = waitNotice("qwen3.8:27b-mlx", 45);
		expect(line).toContain("qwen3.8:27b-mlx");
		expect(line).toBe(
			"qwen3.8:27b-mlx has not answered for 45 s. It may be busy. Esc stops the turn.",
		);
		expect(line).not.toMatch(/—/);
	});

	test("an unknown model still reads as a sentence", () => {
		expect(waitNotice("  ", 50)).toStartWith("The model has not answered");
	});
});

describe("createWaitNoticeGate", () => {
	test("speaks once per quiet spell even though the harness repeats every 15 s", () => {
		const gate = createWaitNoticeGate();
		const m = "qwen3.8:27b-mlx";
		expect(gate("t1", { silentSeconds: 45, model: m })).toContain(m);
		expect(gate("t1", { silentSeconds: 60, model: m })).toBeNull();
		expect(gate("t1", { silentSeconds: 75, model: m })).toBeNull();
	});

	test("a reply re-arms it for the next quiet spell", () => {
		const gate = createWaitNoticeGate();
		const m = "m";
		expect(gate("t1", { silentSeconds: 45, model: m })).not.toBeNull();
		expect(gate("t1", { silentSeconds: null, model: m })).toBeNull();
		expect(gate("t1", { silentSeconds: 45, model: m })).not.toBeNull();
	});

	test("tabs are independent", () => {
		const gate = createWaitNoticeGate();
		expect(gate("a", { silentSeconds: 45, model: "m" })).not.toBeNull();
		expect(gate("b", { silentSeconds: 45, model: "m" })).not.toBeNull();
	});
});
