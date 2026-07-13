/**
 * MoA dispatch verb - the adaptive mixture-of-agents build pipeline as a
 * first-class daemon capability.
 *
 * The adaptive pipeline (packages/orchestration/adaptive-pipeline.ts) runs
 * plan -> compact -> engineer -> repair, escalating locally, and reports
 * progress as free-text log lines plus a structured `stages[]` ledger. That
 * is fine for a CLI, but every surface (Flow, iOS, Telegram, TUI) needs the
 * SAME build, streamed as a typed, turn-scoped event contract so a client
 * can render honest per-stage progress without parsing prose.
 *
 * This module is that contract. It wraps the pipeline and turns its output
 * into `MoaVerbEvent`s, each carrying a `turn_id` so a surface can correlate
 * a stream back to the turn it issued. The pipeline itself is untouched.
 *
 * First slice of issue #2751 (Step 1). The bandit router, agent-pool
 * worktree isolation, and the Flow E2E land in follow-up slices; this is the
 * spine verb + streaming contract they build on.
 */

import {
	type PipelineOptions,
	type PipelineResult,
	runAdaptivePipeline,
} from "../orchestration/adaptive-pipeline";
import type { MoaRouter } from "./moa-router";

/**
 * Turn-scoped streaming event emitted while the MoA verb runs. Every event
 * carries `turn_id` - the cross-surface correlation key already used by the
 * Flow/iOS wire dedup contract - so any client can attach a live view to a
 * build it dispatched and drop duplicates.
 */
export type MoaVerbEvent =
	| { kind: "accepted"; turn_id: string; task: string }
	| { kind: "stage_start"; turn_id: string; stage: string; attempt: number }
	| { kind: "stage_progress"; turn_id: string; stage: string; message: string }
	| {
			kind: "stage_done";
			turn_id: string;
			stage: string;
			provider: string;
			model: string;
			attempts: number;
			ms: number;
			ok: boolean;
			obstacles: string[];
	  }
	| {
			kind: "done";
			turn_id: string;
			ok: boolean;
			defects: string[];
			totalMs: number;
			artifactBytes: number;
	  }
	| { kind: "error"; turn_id: string; error: string };

/** Sink the caller plugs in (a WebSocket writer in the route layer, an array in tests). */
export type MoaEventSink = (event: MoaVerbEvent) => void;

/**
 * Parses the pipeline's free-text `onProgress` lines into typed, turn-scoped
 * stage events. Deterministic and I/O-free - this is the streaming core and
 * is unit-tested against synthetic log lines.
 *
 * The pipeline emits lines shaped `"<stage>: <detail>"`, e.g.
 *   "orchestrator: ollama/qwen (attempt 1) ..."
 *   "engineer: clear (1843 chars)"
 *   "repair pass 2: 3 defect(s)"
 * The prefix before the first ": " is the stage label. A change of stage
 * emits `stage_start` (with the attempt number if the line carries one);
 * every line also emits `stage_progress` so a client sees live liveness.
 */
export class StageStreamParser {
	private currentStage: string | null = null;

	constructor(
		private readonly turnId: string,
		private readonly emit: MoaEventSink,
	) {}

	/** Feed one progress line. Empty/whitespace lines are ignored. */
	feed(line: string): void {
		const text = line.trim();
		if (!text) return;

		const sep = text.indexOf(": ");
		const stage = sep > 0 ? text.slice(0, sep).trim() : (this.currentStage ?? "pipeline");
		const rest = sep > 0 ? text.slice(sep + 2).trim() : text;

		if (stage !== this.currentStage) {
			this.currentStage = stage;
			this.emit({
				kind: "stage_start",
				turn_id: this.turnId,
				stage,
				attempt: parseAttempt(rest),
			});
		}

		this.emit({
			kind: "stage_progress",
			turn_id: this.turnId,
			stage,
			message: rest,
		});
	}
}

/** Extract the attempt number from a line like "... (attempt 3) ...". Defaults to 1. */
function parseAttempt(rest: string): number {
	const m = rest.match(/\(attempt\s+(\d+)\)/i);
	if (!m) return 1;
	const n = Number.parseInt(m[1], 10);
	return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Options for a single MoA verb invocation. */
export interface MoaVerbOptions {
	/** Cross-surface correlation key for this build turn. */
	turnId: string;
	/** The build task / intent. */
	task: string;
	/** Per-stage self-correction budget. Forwarded to the pipeline. */
	maxAttempts?: number;
	/** Where typed events are streamed. */
	emit: MoaEventSink;
	/**
	 * Learned per-task-class model router. When present it (a) chooses each
	 * stage's model via its bandit instead of the static `roles.json`, and
	 * (b) absorbs the run's per-stage outcomes as reward, then persists. When
	 * absent the pipeline routes from config exactly as before.
	 */
	router?: MoaRouter;
	/**
	 * Pipeline runner. Defaults to the real adaptive pipeline; tests inject a
	 * fake so the verb's streaming contract is exercised without any model
	 * call. Kept as a narrow seam, matching the DispatchExecutor pattern.
	 */
	runPipeline?: (opts: PipelineOptions) => Promise<PipelineResult>;
}

/**
 * Run the MoA build pipeline as a dispatch verb, streaming turn-scoped
 * per-stage events. Emits `accepted`, then live `stage_start`/`stage_progress`
 * as the pipeline works, then one authoritative `stage_done` per stage record,
 * then a terminal `done`. On failure emits `error` and rethrows so the caller
 * can surface it. Returns the underlying `PipelineResult`.
 */
export async function runMoaVerb(opts: MoaVerbOptions): Promise<PipelineResult> {
	const { turnId, task, maxAttempts, emit, router } = opts;
	const run = opts.runPipeline ?? runAdaptivePipeline;
	const parser = new StageStreamParser(turnId, emit);

	emit({ kind: "accepted", turn_id: turnId, task });

	let result: PipelineResult;
	try {
		result = await run({
			task,
			maxAttempts,
			onProgress: (m: string) => parser.feed(m),
			// Learned per-task-class selection when a router is wired in.
			selectModel: router?.chooseModel,
		});
	} catch (err) {
		emit({ kind: "error", turn_id: turnId, error: String(err) });
		throw err;
	}

	// Fold this run's per-stage ledger back into the router so the next build
	// routes on real evidence, then persist. Best-effort: a stats write must
	// never fail an otherwise-successful build.
	if (router) {
		try {
			router.recordStages(result.stages);
			router.save();
		} catch {
			/* stats are advisory - a bad write just means we relearn */
		}
	}

	// Authoritative structured ledger: one stage_done per recorded stage.
	for (const rec of result.stages) {
		emit({
			kind: "stage_done",
			turn_id: turnId,
			stage: rec.stage,
			provider: rec.provider,
			model: rec.model,
			attempts: rec.attempts,
			ms: rec.ms,
			ok: rec.ok,
			obstacles: rec.obstacles,
		});
	}

	emit({
		kind: "done",
		turn_id: turnId,
		ok: result.ok,
		defects: result.defects,
		totalMs: result.totalMs,
		artifactBytes: result.artifact.length,
	});

	return result;
}

/**
 * Bridge a `MoaVerbEvent` onto the existing dispatch wire event shape
 * (`DispatchEventFrame.event`: `{ kind, ...payload }`, kinds limited to
 * accepted|stream|tool_call|tool_result|error|done). MoA's fine-grained
 * stage kinds ride inside `kind: "stream"` under a `moa` payload so the wire
 * union stays unchanged; accepted/error/done map straight through. A later
 * slice plugs this into `DispatchHub.emit` on the route layer.
 */
export function toDispatchEvent(e: MoaVerbEvent): {
	kind: "accepted" | "stream" | "error" | "done";
	[key: string]: unknown;
} {
	switch (e.kind) {
		case "accepted":
			return { kind: "accepted", turn_id: e.turn_id, task: e.task };
		case "error":
			return { kind: "error", turn_id: e.turn_id, error: e.error };
		case "done":
			return {
				kind: "done",
				turn_id: e.turn_id,
				ok: e.ok,
				defects: e.defects,
				totalMs: e.totalMs,
				artifactBytes: e.artifactBytes,
			};
		default:
			// stage_start | stage_progress | stage_done -> streamed MoA detail.
			return { kind: "stream", turn_id: e.turn_id, moa: e };
	}
}
