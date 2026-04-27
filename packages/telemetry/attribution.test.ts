/**
 * Attribution + emitter tests.
 *
 * The Wave 4 gate: every event carries tenantId. Anything missing it
 * gets thrown loudly so we catch un-instrumented call sites in dev
 * instead of finding out from a billing reconciliation.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	MemorySink,
	TelemetryAttributionError,
	estimateCostUsd,
	isLLMEvent,
	isStorageEvent,
	isValidSpanId,
	isValidTraceId,
	isVesselEvent,
	newSpanContext,
	recordLLM,
	recordStorage,
	recordVessel,
	resetSinkToStdout,
	setSink,
	telemetry,
} from "./index";

let sink: MemorySink;

beforeEach(() => {
	sink = new MemorySink();
	setSink(sink);
});

afterEach(() => {
	resetSinkToStdout();
});

describe("attribution gate", () => {
	it("rejects an LLM event with no tenantId", () => {
		expect(() =>
			recordLLM({
				// @ts-expect-error — deliberately missing tenantId
				tenantId: undefined,
				provider: "openrouter",
				model: "qwen3.5:14b",
				promptTokens: 10,
				completionTokens: 5,
				latencyMs: 100,
			}),
		).toThrow(TelemetryAttributionError);
		expect(sink.events).toHaveLength(0);
	});

	it("rejects an empty-string tenantId", () => {
		expect(() =>
			recordVessel({
				tenantId: "",
				endpoint: "/agent/chat",
				durationMs: 42,
			}),
		).toThrow(TelemetryAttributionError);
	});

	it("rejects a storage event with no tenantId", () => {
		expect(() =>
			// @ts-expect-error — deliberately missing tenantId
			recordStorage({ op: "write", store: "memory.db", bytes: 1024 }),
		).toThrow(TelemetryAttributionError);
	});
});

describe("LLM event", () => {
	it("emits a fully-stamped llm event", () => {
		const ev = recordLLM({
			tenantId: "james",
			sessionId: "sess-1",
			channel: "telegram",
			provider: "openrouter",
			model: "qwen3.5:14b",
			promptTokens: 1000,
			completionTokens: 500,
			latencyMs: 250,
		});

		expect(sink.events).toHaveLength(1);
		expect(isLLMEvent(sink.events[0])).toBe(true);
		const stored = sink.events[0];
		if (!isLLMEvent(stored)) throw new Error("type guard failed");
		expect(stored.tenantId).toBe("james");
		expect(stored.totalTokens).toBe(1500);
		expect(stored.costUsd).toBeGreaterThan(0);
		expect(stored.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(isValidTraceId(stored.traceId ?? "")).toBe(true);
		expect(isValidSpanId(stored.spanId ?? "")).toBe(true);
		expect(stored.startTimeUnixNano).toBeGreaterThan(0);
		expect(stored.endTimeUnixNano).toBeGreaterThanOrEqual(stored.startTimeUnixNano ?? 0);
		expect(ev.spanId).toBe(stored.spanId);
	});

	it("zero cost for local providers", () => {
		recordLLM({
			tenantId: "james",
			provider: "ollama",
			model: "eight-1.0-q3:14b",
			promptTokens: 100_000,
			completionTokens: 100_000,
			latencyMs: 1,
		});
		const ev = sink.events[0];
		if (!isLLMEvent(ev)) throw new Error("expected llm");
		expect(ev.costUsd).toBe(0);
	});

	it("cost estimator scales with token count", () => {
		const cheap = estimateCostUsd("openai", "gpt-5", 1000, 500);
		const expensive = estimateCostUsd("openai", "gpt-5", 100_000, 50_000);
		expect(expensive).toBeGreaterThan(cheap * 50);
	});
});

describe("vessel + storage events", () => {
	it("records a vessel event", () => {
		recordVessel({
			tenantId: "tenant-2",
			endpoint: "/agent/chat",
			durationMs: 142,
			status: 200,
			bytesIn: 512,
			bytesOut: 4096,
		});
		expect(sink.events).toHaveLength(1);
		const ev = sink.events[0];
		if (!isVesselEvent(ev)) throw new Error("expected vessel");
		expect(ev.endpoint).toBe("/agent/chat");
		expect(ev.bytesOut).toBe(4096);
	});

	it("records a storage event", () => {
		recordStorage({
			tenantId: "tenant-3",
			op: "write",
			store: "memory.db",
			bytes: 2048,
		});
		expect(sink.events).toHaveLength(1);
		const ev = sink.events[0];
		if (!isStorageEvent(ev)) throw new Error("expected storage");
		expect(ev.bytes).toBe(2048);
		expect(ev.op).toBe("write");
	});
});

describe("wrapper API", () => {
	it("times an LLM call and emits success event", async () => {
		const res = await telemetry.llm(
			{
				tenantId: "james",
				provider: "openrouter",
				model: "qwen3.5:14b",
			},
			async () => {
				await new Promise((r) => setTimeout(r, 10));
				return { result: "hello", usage: { promptTokens: 50, completionTokens: 25 } };
			},
		);
		expect(res).toBe("hello");
		expect(sink.events).toHaveLength(1);
		const ev = sink.events[0];
		if (!isLLMEvent(ev)) throw new Error("expected llm");
		expect(ev.promptTokens).toBe(50);
		expect(ev.completionTokens).toBe(25);
		expect(ev.latencyMs).toBeGreaterThanOrEqual(10);
		expect(ev.error).toBeUndefined();
	});

	it("emits an error event when the wrapped call throws", async () => {
		await expect(
			telemetry.llm({ tenantId: "james", provider: "openrouter", model: "x" }, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(sink.events).toHaveLength(1);
		const ev = sink.events[0];
		if (!isLLMEvent(ev)) throw new Error("expected llm");
		expect(ev.error).toBe("boom");
		expect(ev.promptTokens).toBe(0);
	});

	it("times a vessel call", async () => {
		const out = await telemetry.vessel(
			{ tenantId: "tenant-4", endpoint: "/board/query" },
			async () => 42,
		);
		expect(out).toBe(42);
		const ev = sink.events[0];
		if (!isVesselEvent(ev)) throw new Error("expected vessel");
		expect(ev.status).toBe(200);
	});

	it("times a storage op and captures bytes", async () => {
		const out = await telemetry.storage(
			{ tenantId: "tenant-5", op: "read", store: "blob" },
			async () => ({ result: "data", bytes: 1234 }),
		);
		expect(out).toBe("data");
		const ev = sink.events[0];
		if (!isStorageEvent(ev)) throw new Error("expected storage");
		expect(ev.bytes).toBe(1234);
	});
});

describe("OTel context propagation", () => {
	it("threads parent span id into child events", () => {
		const parent = newSpanContext();
		recordLLM(
			{
				tenantId: "james",
				provider: "ollama",
				model: "eight-1.0-q3:14b",
				promptTokens: 1,
				completionTokens: 1,
				latencyMs: 1,
			},
			newSpanContext(parent),
		);
		const ev = sink.events[0];
		if (!isLLMEvent(ev)) throw new Error("expected llm");
		expect(ev.traceId).toBe(parent.traceId);
		expect(ev.parentSpanId).toBe(parent.spanId);
	});

	it("generates valid 32-hex trace ids and 16-hex span ids", () => {
		const ctx = newSpanContext();
		expect(isValidTraceId(ctx.traceId)).toBe(true);
		expect(isValidSpanId(ctx.spanId)).toBe(true);
	});
});
