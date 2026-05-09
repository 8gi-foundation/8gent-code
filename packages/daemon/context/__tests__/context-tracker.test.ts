/**
 * Tests for ContextTracker (issue #2420).
 *
 * Verifies cumulative token tracking, near-limit thresholds, and the
 * `resetTo(messages)` path used after compression.
 */

import { describe, expect, it } from "bun:test";
import { ContextTracker, estimateExchangeTokens } from "../context-tracker";

describe("ContextTracker", () => {
	it("starts at zero and respects context window", () => {
		const t = new ContextTracker({ contextWindow: 8000 });
		const usage = t.getUsage();
		expect(usage.input).toBe(0);
		expect(usage.output).toBe(0);
		expect(usage.total).toBe(0);
		expect(usage.contextWindow).toBe(8000);
		expect(usage.ratio).toBe(0);
		expect(usage.remaining).toBe(8000);
	});

	it("accumulates input and output tokens separately", () => {
		const t = new ContextTracker({ contextWindow: 1000 });
		t.recordInput(120);
		t.recordOutput(80);
		t.recordExchange(60, 40);
		const usage = t.getUsage();
		expect(usage.input).toBe(180);
		expect(usage.output).toBe(120);
		expect(usage.total).toBe(300);
		expect(usage.ratio).toBeCloseTo(0.3);
		expect(usage.remaining).toBe(700);
	});

	it("ignores negative values silently", () => {
		const t = new ContextTracker({ contextWindow: 1000 });
		t.recordInput(-50);
		t.recordOutput(-50);
		expect(t.getUsage().total).toBe(0);
	});

	it("isNearLimit triggers at and beyond threshold", () => {
		const t = new ContextTracker({ contextWindow: 1000 });
		t.recordInput(700);
		expect(t.isNearLimit(0.75)).toBe(false);
		t.recordInput(50);
		expect(t.isNearLimit(0.75)).toBe(true);
		expect(t.isNearLimit(0.5)).toBe(true);
		expect(t.isNearLimit(0.95)).toBe(false);
	});

	it("uses default 0.75 threshold when none supplied", () => {
		const t = new ContextTracker({ contextWindow: 1000 });
		t.recordInput(749);
		expect(t.isNearLimit()).toBe(false);
		t.recordInput(2);
		expect(t.isNearLimit()).toBe(true);
	});

	it("resetTo recomputes from a fresh message array", () => {
		const t = new ContextTracker({ contextWindow: 1000 });
		t.recordExchange(500, 200);
		expect(t.getUsage().total).toBeGreaterThan(0);
		t.resetTo([
			{ role: "system", content: "you are a helpful agent" },
			{ role: "user", content: "hello" },
		]);
		const usage = t.getUsage();
		expect(usage.output).toBe(0);
		expect(usage.input).toBeGreaterThan(0);
		expect(usage.input).toBeLessThan(50);
	});

	it("setContextWindow rejects non-positive values", () => {
		const t = new ContextTracker({ contextWindow: 1000 });
		t.setContextWindow(0);
		expect(t.getContextWindow()).toBe(1000);
		t.setContextWindow(-1);
		expect(t.getContextWindow()).toBe(1000);
		t.setContextWindow(2048);
		expect(t.getContextWindow()).toBe(2048);
	});
});

describe("estimateExchangeTokens", () => {
	it("returns separate prompt/completion estimates that sum to total", () => {
		const result = estimateExchangeTokens("hello world", "this is a reply with more words");
		expect(result.prompt).toBeGreaterThan(0);
		expect(result.completion).toBeGreaterThan(result.prompt);
		expect(result.total).toBe(result.prompt + result.completion);
	});

	it("handles empty strings", () => {
		const result = estimateExchangeTokens("", "");
		expect(result).toEqual({ prompt: 0, completion: 0, total: 0 });
	});
});
