import { afterEach, describe, expect, test } from "bun:test";

import { PipelineEventBus, toProgressLine } from "./pipeline-events.js";
import type { PipelineEvent } from "./pipeline-contracts.js";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("PipelineEventBus", () => {
	test("subscribe + emit delivers the exact events to a sink", () => {
		const bus = new PipelineEventBus();
		const seen: PipelineEvent[] = [];
		bus.subscribe((e) => seen.push(e));

		const a: PipelineEvent = { kind: "stage", stage: "engineer", status: "start" };
		const b: PipelineEvent = { kind: "unit", unitId: "x", path: "components/hero.tsx", status: "done" };
		bus.emit(a);
		bus.emit(b);

		expect(seen).toEqual([a, b]);
	});

	test("unsubscribe stops delivery", () => {
		const bus = new PipelineEventBus();
		const seen: PipelineEvent[] = [];
		const off = bus.subscribe((e) => seen.push(e));

		bus.emit({ kind: "done", ok: true });
		off();
		bus.emit({ kind: "done", ok: false });

		expect(seen).toHaveLength(1);
	});

	test("a throwing sink does not break emit for other sinks", () => {
		const bus = new PipelineEventBus();
		const seen: PipelineEvent[] = [];
		bus.subscribe(() => {
			throw new Error("bad sink");
		});
		bus.subscribe((e) => seen.push(e));

		expect(() => bus.emit({ kind: "instruction", text: "keep going" })).not.toThrow();
		expect(seen).toHaveLength(1);
	});

	test("onLine receives a rendered log line", () => {
		const lines: string[] = [];
		const bus = new PipelineEventBus({ onLine: (l) => lines.push(l) });
		bus.emit({ kind: "stage", stage: "engineer", status: "clear", model: "lmstudio:ornith-1.0-9b" });
		expect(lines[0]).toBe("stage:clear engineer (lmstudio:ornith-1.0-9b)");
	});

	test("httpSink fire-and-forget POSTs the event as JSON", async () => {
		const calls: { url: string; body: unknown }[] = [];
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			calls.push({ url, body: JSON.parse(String(init?.body)) });
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const bus = new PipelineEventBus({ httpSink: "http://localhost:7890/pipeline-events" });
		bus.emit({ kind: "obstacle", stage: "engineer", obstacle: "compile-error", severity: "severe" });

		// fetch is invoked synchronously inside emit.
		expect(calls).toHaveLength(1);
		await Promise.all(bus.pending);

		expect(calls[0].url).toBe("http://localhost:7890/pipeline-events");
		expect(calls[0].body).toMatchObject({ kind: "obstacle", obstacle: "compile-error" });
	});

	test("httpSink swallows fetch errors and never throws", async () => {
		globalThis.fetch = (async () => {
			throw new Error("network down");
		}) as typeof fetch;

		const bus = new PipelineEventBus({ httpSink: "http://localhost:7890/pipeline-events" });
		expect(() => bus.emit({ kind: "done", ok: true })).not.toThrow();
		await expect(Promise.all(bus.pending)).resolves.toBeDefined();
	});
});

describe("toProgressLine", () => {
	test("stage", () => {
		expect(toProgressLine({ kind: "stage", stage: "engineer", status: "clear", model: "lmstudio:ornith-1.0-9b" })).toBe(
			"stage:clear engineer (lmstudio:ornith-1.0-9b)",
		);
	});

	test("unit", () => {
		expect(toProgressLine({ kind: "unit", unitId: "x", path: "components/hero.tsx", status: "done" })).toBe(
			"unit:done components/hero.tsx",
		);
	});

	test("obstacle", () => {
		expect(toProgressLine({ kind: "obstacle", stage: "engineer", obstacle: "compile-error", severity: "severe" })).toBe(
			"obstacle[severe] engineer: compile-error",
		);
	});

	test("decision", () => {
		const line = toProgressLine({ kind: "decision", stage: "engineer", strategy: "escalate", rationale: "2 severe" });
		expect(line).toBe("decision engineer -> escalate (2 severe)");
		expect(line.length).toBeGreaterThan(0);
	});

	test("escalate + instruction + done are non-empty", () => {
		expect(toProgressLine({ kind: "escalate", from: "qwen", to: "ornith", reason: "stuck" })).toBe(
			"escalate qwen -> ornith (stuck)",
		);
		expect(toProgressLine({ kind: "instruction", text: "use tabs" }).length).toBeGreaterThan(0);
		expect(toProgressLine({ kind: "done", ok: true, artifact: "dist/site" }).length).toBeGreaterThan(0);
	});
});
