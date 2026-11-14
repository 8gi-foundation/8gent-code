import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ATTR,
	FileSpanSink,
	MemorySpanSink,
	RunTracer,
	exportOtlp,
	formatRunTree,
	runTotals,
	startRunTrace,
	toOtlp,
	traceCommand,
} from "./run-trace";

/** A clock the test moves by hand, in ms. */
function clock(start = 1_700_000_000_000) {
	let t = start;
	return { now: () => t, tick: (ms: number) => void (t += ms) };
}

/** A fake run: two model calls around one good and one failing tool call. */
function fakeRun(sink = new MemorySpanSink()) {
	const c = clock();
	const tr = new RunTracer({
		sessionId: "session_1",
		provider: "8gent",
		model: "eight-1.0-q3:14b",
		officer: "rishi",
		sink,
		now: c.now,
	});
	tr.modelStart(0, "8gent", "eight-1.0-q3:14b");
	c.tick(2000);
	tr.modelEnd(0, { promptTokens: 1200, completionTokens: 300 }, "tool-calls");
	tr.toolStart("t1", "read_file");
	c.tick(100);
	tr.toolEnd("t1", "read_file", true);
	tr.toolStart("t2", "run_command");
	c.tick(400);
	tr.toolEnd("t2", "run_command", false);
	tr.modelStart(1, "openrouter", "qwen3.5:14b");
	c.tick(1500);
	tr.modelEnd(1, { promptTokens: 1000000, completionTokens: 1000000 }, "stop");
	tr.end("ok");
	return { tr, sink };
}

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("run trace", () => {
	test("a fake run produces the expected tree and totals", () => {
		const { tr, sink } = fakeRun();
		const tree = formatRunTree(sink.spans);
		expect(tree).toBe(
			[
				`run ${tr.runId}  officer rishi  session session_1  ok  4.0s`,
				"  model 8gent/eight-1.0-q3:14b  in 1200  out 300  2.0s",
				"  tool read_file  ok  0.1s",
				"  tool run_command  error  0.4s",
				"  model openrouter/qwen3.5:14b  in 1000000  out 1000000  1.5s",
				"",
				"totals: 2 model calls, 2 tool calls (1 failed), tokens in 1001200 out 1000300, est. cost $2.000000, 4.0s",
			].join("\n"),
		);
		expect(runTotals(sink.spans)).toEqual({
			modelCalls: 2,
			toolCalls: 2,
			toolFailures: 1,
			tokensIn: 1001200,
			tokensOut: 1000300,
			costUsd: 2,
			durationMs: 4000,
		});
	});

	test("spans have the OpenTelemetry shape: one trace, root parent of every call", () => {
		const { tr, sink } = fakeRun();
		const root = sink.spans.find((s) => s.kind === "run");
		expect(root?.parentSpanId).toBeUndefined();
		expect(tr.runId).toMatch(/^[0-9a-f]{32}$/);
		for (const s of sink.spans) {
			expect(s.traceId).toBe(tr.runId);
			expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
			if (s.kind !== "run") expect(s.parentSpanId).toBe(root?.spanId);
			expect(s.endTimeUnixNano).toBeGreaterThanOrEqual(s.startTimeUnixNano);
		}
		expect(root?.attributes[ATTR.outcome]).toBe("ok");
	});

	test("status notices with no tokens are not model calls; unannounced calls with tokens are", () => {
		const sink = new MemorySpanSink();
		const tr = new RunTracer({ sessionId: "s", provider: "ollama", model: "m", sink });
		tr.modelEnd(0, { promptTokens: 0, completionTokens: 0 }, "other");
		tr.modelEnd(3, { promptTokens: 5, completionTokens: 7 }, "stop");
		tr.end("ok");
		expect(runTotals(sink.spans)).toMatchObject({ modelCalls: 1, tokensIn: 5, tokensOut: 7 });
	});

	test("calls still open at the end are closed as unfinished and the run is idempotent", () => {
		const sink = new MemorySpanSink();
		const tr = new RunTracer({ sessionId: "s", provider: "ollama", model: "m", sink });
		tr.toolStart("t", "spawn_agent");
		tr.end("error");
		tr.end("ok");
		expect(sink.spans).toHaveLength(2);
		expect(sink.spans[0].attributes[ATTR.outcome]).toBe("unfinished");
		expect(sink.spans[1].attributes[ATTR.outcome]).toBe("error");
	});

	test("a failing sink never throws into the run", () => {
		const tr = new RunTracer({
			sessionId: "s",
			provider: "ollama",
			model: "m",
			sink: {
				write: () => {
					throw new Error("disk full");
				},
			},
		});
		expect(() => {
			tr.toolStart("t", "x");
			tr.toolEnd("t", "x", true);
			tr.end("ok");
		}).not.toThrow();
	});

	test("written locally as JSONL and shown by `trace show`, latest by default", () => {
		const dir = mkdtempSync(join(tmpdir(), "run-trace-"));
		dirs.push(dir);
		const { tr } = fakeRun(new FileSpanSink(dir) as unknown as MemorySpanSink);
		const lines = readFileSync(join(dir, `${tr.runId}.jsonl`), "utf8")
			.trim()
			.split("\n");
		expect(lines).toHaveLength(5);
		const out: string[] = [];
		expect(traceCommand(["show", tr.runId.slice(0, 8)], (l) => out.push(l), dir)).toBe(0);
		expect(out.join("\n")).toContain("  tool run_command  error  0.4s");
		const latest: string[] = [];
		expect(traceCommand(["show"], (l) => latest.push(l), dir)).toBe(0);
		expect(latest).toEqual(out);
		expect(traceCommand(["show", "ffffffff"], () => {}, dir)).toBe(1);
		expect(traceCommand(["show", "../etc"], () => {}, dir)).toBe(1);
	});

	test("off by switch; no network unless EIGHT_TRACE_OTLP_ENDPOINT is set", async () => {
		expect(
			startRunTrace({ sessionId: "s", provider: "p", model: "m" }, { EIGHT_TRACE: "off" }),
		).toBeNull();
		// Under bun test with no explicit dir, the default file sink stays off.
		expect(
			startRunTrace({ sessionId: "s", provider: "p", model: "m" }, { NODE_ENV: "test" }),
		).toBeNull();

		const sink = new MemorySpanSink();
		const realFetch = globalThis.fetch;
		const calls: string[] = [];
		globalThis.fetch = (async (url: string) => {
			calls.push(String(url));
			return new Response("{}");
		}) as unknown as typeof fetch;
		try {
			startRunTrace({ sessionId: "s", provider: "p", model: "m", sink }, {})?.end("ok");
			expect(calls).toEqual([]);
			startRunTrace(
				{ sessionId: "s", provider: "p", model: "m", sink },
				{ EIGHT_TRACE_OTLP_ENDPOINT: "http://127.0.0.1:4318/" },
			)?.end("ok");
			await Bun.sleep(0);
			expect(calls).toEqual(["http://127.0.0.1:4318/v1/traces"]);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test("OTLP payload carries ids, parents and typed attributes", async () => {
		const { sink } = fakeRun();
		const body = toOtlp(sink.spans) as {
			resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>;
		};
		const spans = body.resourceSpans[0].scopeSpans[0].spans;
		expect(spans).toHaveLength(5);
		const model = spans.find((s) => String(s.name).startsWith("model 8gent")) as {
			startTimeUnixNano: string;
			attributes: Array<{ key: string; value: Record<string, unknown> }>;
		};
		expect(model.startTimeUnixNano).toMatch(/^\d+$/);
		expect(model.attributes).toContainEqual({ key: ATTR.tokensIn, value: { intValue: "1200" } });
		let posted = "";
		await exportOtlp(sink.spans, "http://collector", (async (_u: string, init: RequestInit) => {
			posted = String(init.body);
			return new Response("{}");
		}) as unknown as typeof fetch);
		expect(JSON.parse(posted).resourceSpans[0].scopeSpans[0].spans).toHaveLength(5);
	});
});
