import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeFlowMetrics,
	deferredVsDelivered,
	interruptionsPerHour,
	longestUninterruptedRuns,
	readFlowRecords,
	thinkingRuns,
} from "./flow-metrics";
import { type FlowRecord, writeFlowRecord } from "./flow-stream";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "flow-metrics-"));
	process.env.FLOW_TELEMETRY_DIR = dir;
});
afterEach(() => {
	delete process.env.FLOW_TELEMETRY_DIR;
	rmSync(dir, { recursive: true, force: true });
});

const at = (minute: number): string => new Date(Date.UTC(2026, 7, 11, 9, minute, 0)).toISOString();

const presence = (minute: number, state: "thinking" | "idle", agentId = "agent:8TO"): FlowRecord => ({
	v: 1,
	kind: "presence",
	ts: at(minute),
	channelId: "chan_1",
	agentId,
	state,
});
const notification = (minute: number, disposition: "delivered" | "deferred" = "delivered"): FlowRecord => ({
	v: 1,
	kind: "notification",
	ts: at(minute),
	ntype: "task-complete",
	disposition,
	channel: "telegram",
});

describe("interruptionsPerHour", () => {
	test("counts delivered notifications over the observed span", () => {
		// Span 09:00 -> 09:30 = 0.5h, 2 delivered -> 4/h. Deferred does not count.
		const records = [
			presence(0, "thinking"),
			notification(5),
			notification(10),
			notification(12, "deferred"),
			presence(30, "idle"),
		];
		const m = interruptionsPerHour(records);
		expect(m.interruptions).toBe(2);
		expect(m.observedHours).toBeCloseTo(0.5, 5);
		expect(m.perHour).toBeCloseTo(4, 5);
	});

	test("degenerate inputs do not divide by zero", () => {
		expect(interruptionsPerHour([]).perHour).toBe(0);
		expect(interruptionsPerHour([notification(0)]).perHour).toBe(0);
		expect(interruptionsPerHour([notification(0), notification(0)]).perHour).toBe(0);
	});
});

describe("thinkingRuns", () => {
	test("pairs thinking->idle per channel+agent and flags interruptions", () => {
		const records = [
			presence(0, "thinking"), // 8TO: 0-10, notification at 5 inside -> interrupted
			notification(5),
			presence(12, "thinking", "agent:8EO"), // 8EO: 12-20, no notification inside -> clean
			presence(10, "idle"),
			presence(20, "idle", "agent:8EO"),
		];
		const runs = thinkingRuns(records);
		expect(runs.length).toBe(2);
		const rishi = runs.find((r) => r.agentId === "agent:8TO");
		const eo = runs.find((r) => r.agentId === "agent:8EO");
		expect(rishi?.durationMs).toBe(10 * 60_000);
		expect(rishi?.uninterrupted).toBe(false);
		expect(eo?.durationMs).toBe(8 * 60_000);
		expect(eo?.uninterrupted).toBe(true);
	});

	test("drops unpaired transitions instead of guessing", () => {
		// idle with no thinking; thinking with no idle (daemon restart shape)
		const records = [presence(0, "idle"), presence(5, "thinking")];
		expect(thinkingRuns(records).length).toBe(0);
	});

	test("re-announced thinking restarts the run (matches noteActivity upsert)", () => {
		const records = [presence(0, "thinking"), presence(8, "thinking"), presence(10, "idle")];
		const runs = thinkingRuns(records);
		expect(runs.length).toBe(1);
		expect(runs[0]?.durationMs).toBe(2 * 60_000);
	});
});

describe("longestUninterruptedRuns", () => {
	test("returns only uninterrupted runs, longest first, capped at topN", () => {
		const records = [
			presence(0, "thinking"),
			presence(4, "idle"), // 4 min clean
			presence(5, "thinking"),
			presence(30, "idle"), // 25 min clean
			presence(31, "thinking"),
			notification(35),
			presence(40, "idle"), // 9 min interrupted
		];
		const top = longestUninterruptedRuns(records, 2);
		expect(top.map((r) => r.durationMs)).toEqual([25 * 60_000, 4 * 60_000]);
	});
});

describe("deferredVsDelivered", () => {
	test("field present, deferred honestly zero until flow mode ships", () => {
		const counts = deferredVsDelivered([notification(0), notification(1), presence(2, "thinking")]);
		expect(counts).toEqual({ deferred: 0, delivered: 2 });
	});

	test("counts deferred once flow mode produces them", () => {
		expect(deferredVsDelivered([notification(0, "deferred"), notification(1)])).toEqual({
			deferred: 1,
			delivered: 1,
		});
	});
});

describe("readFlowRecords + computeFlowMetrics end to end", () => {
	test("reads what the writer wrote, skips nothing valid, summarizes", () => {
		for (const r of [presence(0, "thinking"), notification(5, "deferred"), presence(10, "idle"), notification(12)])
			expect(writeFlowRecord(r)).toBe(true);
		const { records, skipped } = readFlowRecords();
		expect(records.length).toBe(4);
		expect(skipped).toBe(0);
		const summary = computeFlowMetrics(records);
		expect(summary.totalRecords).toBe(4);
		expect(summary.counts).toEqual({ deferred: 1, delivered: 1 });
		// deferred at 09:05 sits inside the 0-10 run but did NOT interrupt (it was deferred)
		expect(summary.longestUninterruptedRunsMs).toEqual([10 * 60_000]);
	});
});
