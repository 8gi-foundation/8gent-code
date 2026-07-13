/**
 * Tests for the MoA dispatch verb's streaming contract. The pipeline runner
 * is faked, so these exercise the turn_id tagging, stage-stream parsing, and
 * event ordering with no model call or network.
 */

import { describe, expect, test } from "bun:test";
import type { PipelineOptions, PipelineResult } from "../orchestration/adaptive-pipeline";
import { type MoaVerbEvent, StageStreamParser, runMoaVerb, toDispatchEvent } from "./moa-verb";

describe("StageStreamParser", () => {
	test("emits one stage_start per distinct stage and progress for every line", () => {
		const events: MoaVerbEvent[] = [];
		const p = new StageStreamParser("turn-1", (e) => events.push(e));

		p.feed("orchestrator: ollama/qwen (attempt 1) ...");
		p.feed("orchestrator: clear (812 chars)");
		p.feed("engineer: ollama/gemma (attempt 1) ...");
		p.feed("engineer: clear (1843 chars)");

		const starts = events.filter((e) => e.kind === "stage_start");
		expect(starts.map((e) => (e.kind === "stage_start" ? e.stage : ""))).toEqual([
			"orchestrator",
			"engineer",
		]);
		// Four fed lines -> four progress events.
		expect(events.filter((e) => e.kind === "stage_progress")).toHaveLength(4);
	});

	test("tags every event with the turn_id", () => {
		const events: MoaVerbEvent[] = [];
		const p = new StageStreamParser("turn-xyz", (e) => events.push(e));
		p.feed("engineer: ollama/gemma (attempt 2) ...");
		expect(events.every((e) => e.turn_id === "turn-xyz")).toBe(true);
	});

	test("parses the attempt number into stage_start", () => {
		const events: MoaVerbEvent[] = [];
		const p = new StageStreamParser("t", (e) => events.push(e));
		p.feed("engineer: ollama/gemma (attempt 3) ...");
		const start = events.find((e) => e.kind === "stage_start");
		expect(start?.kind === "stage_start" && start.attempt).toBe(3);
	});

	test("defaults attempt to 1 when the line carries no attempt marker", () => {
		const events: MoaVerbEvent[] = [];
		const p = new StageStreamParser("t", (e) => events.push(e));
		p.feed("repair pass 1: 3 defect(s)");
		const start = events.find((e) => e.kind === "stage_start");
		expect(start?.kind === "stage_start" && start.attempt).toBe(1);
	});

	test("ignores blank lines", () => {
		const events: MoaVerbEvent[] = [];
		const p = new StageStreamParser("t", (e) => events.push(e));
		p.feed("   ");
		p.feed("");
		expect(events).toHaveLength(0);
	});

	test("a line with no stage prefix attaches to the current stage", () => {
		const events: MoaVerbEvent[] = [];
		const p = new StageStreamParser("t", (e) => events.push(e));
		p.feed("engineer: ollama/gemma (attempt 1) ...");
		p.feed("some free-form note without a colon prefix");
		const progress = events.filter((e) => e.kind === "stage_progress");
		expect(progress).toHaveLength(2);
		expect(progress[1].kind === "stage_progress" && progress[1].stage).toBe("engineer");
	});
});

// A fake pipeline that replays synthetic progress lines then returns a fixed
// result. No models, no network - it proves the verb's streaming contract.
function fakePipeline(result: PipelineResult): (opts: PipelineOptions) => Promise<PipelineResult> {
	return async (opts: PipelineOptions) => {
		opts.onProgress?.("orchestrator: ollama/qwen (attempt 1) ...");
		opts.onProgress?.("orchestrator: clear (500 chars)");
		opts.onProgress?.("engineer: ollama/gemma (attempt 1) ...");
		opts.onProgress?.("engineer: clear (1500 chars)");
		return result;
	};
}

const RESULT: PipelineResult = {
	artifact: "<!doctype html><html><body>ok</body></html>",
	ok: true,
	defects: [],
	totalMs: 4200,
	stages: [
		{
			stage: "orchestrator",
			provider: "ollama",
			model: "qwen",
			attempts: 1,
			ms: 900,
			ok: true,
			obstacles: [],
		},
		{
			stage: "engineer",
			provider: "ollama",
			model: "gemma",
			attempts: 1,
			ms: 3300,
			ok: true,
			obstacles: [],
		},
	],
};

describe("runMoaVerb", () => {
	test("streams accepted -> stage stream -> stage_done ledger -> done, all turn-scoped", async () => {
		const events: MoaVerbEvent[] = [];
		const result = await runMoaVerb({
			turnId: "turn-42",
			task: "Build a landing page",
			emit: (e) => events.push(e),
			runPipeline: fakePipeline(RESULT),
		});

		expect(result).toBe(RESULT);
		expect(events.every((e) => e.turn_id === "turn-42")).toBe(true);

		// First event is accepted with the task.
		expect(events[0]).toEqual({
			kind: "accepted",
			turn_id: "turn-42",
			task: "Build a landing page",
		});

		// Last event is a done carrying honest totals from the result.
		const last = events[events.length - 1];
		expect(last).toEqual({
			kind: "done",
			turn_id: "turn-42",
			ok: true,
			defects: [],
			totalMs: 4200,
			artifactBytes: RESULT.artifact.length,
		});

		// One authoritative stage_done per recorded stage.
		const done = events.filter((e) => e.kind === "stage_done");
		expect(done.map((e) => (e.kind === "stage_done" ? e.stage : ""))).toEqual([
			"orchestrator",
			"engineer",
		]);
	});

	test("emits live stage_start events from the pipeline's progress stream", async () => {
		const events: MoaVerbEvent[] = [];
		await runMoaVerb({
			turnId: "t",
			task: "x",
			emit: (e) => events.push(e),
			runPipeline: fakePipeline(RESULT),
		});
		const starts = events.filter((e) => e.kind === "stage_start");
		expect(starts.map((e) => (e.kind === "stage_start" ? e.stage : ""))).toEqual([
			"orchestrator",
			"engineer",
		]);
	});

	test("emits error and rethrows when the pipeline throws", async () => {
		const events: MoaVerbEvent[] = [];
		const boom = async () => {
			throw new Error("provider down");
		};
		await expect(
			runMoaVerb({ turnId: "t-err", task: "x", emit: (e) => events.push(e), runPipeline: boom }),
		).rejects.toThrow("provider down");

		const err = events.find((e) => e.kind === "error");
		expect(err?.kind === "error" && err.turn_id).toBe("t-err");
		expect(err?.kind === "error" && err.error).toContain("provider down");
	});
});

describe("toDispatchEvent", () => {
	test("maps accepted/error/done straight through", () => {
		expect(toDispatchEvent({ kind: "accepted", turn_id: "t", task: "x" }).kind).toBe("accepted");
		expect(toDispatchEvent({ kind: "error", turn_id: "t", error: "e" }).kind).toBe("error");
		expect(
			toDispatchEvent({
				kind: "done",
				turn_id: "t",
				ok: true,
				defects: [],
				totalMs: 1,
				artifactBytes: 2,
			}).kind,
		).toBe("done");
	});

	test("carries stage detail inside kind:stream without widening the wire union", () => {
		const wire = toDispatchEvent({
			kind: "stage_start",
			turn_id: "t",
			stage: "engineer",
			attempt: 1,
		});
		expect(wire.kind).toBe("stream");
		expect((wire.moa as MoaVerbEvent).kind).toBe("stage_start");
	});
});
