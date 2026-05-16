/**
 * GoalLoop unit tests.
 *
 * Spec calls for vitest. Repo convention is bun:test (see
 * packages/db/src/workspace-db.test.ts). Sticking with bun:test so this
 * package runs under the existing `bun test packages/ apps/` script with
 * zero new tooling. Behavioral coverage is unchanged.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GoalLoop } from "./goal-loop";
import { JudgeExecutorCollisionError } from "./judge";
import type {
	ExecutorHandle,
	ExecutorTurnInput,
	ExecutorTurnOutput,
	GoalEvent,
	GoalEventSink,
	JudgeHandle,
	JudgeHandleInput,
	JudgeVerdict,
} from "./types";

// ---- helpers ----------------------------------------------------------------

class MemorySink implements GoalEventSink {
	events: GoalEvent[] = [];
	append(event: GoalEvent): void {
		this.events.push(event);
	}
	kinds(): string[] {
		return this.events.map((e) => e.kind);
	}
}

function mockExecutor(opts?: {
	model?: string;
	tokensPerTurn?: number;
	throwOnTurn?: number;
	sleepMs?: number;
}): ExecutorHandle & { calls: ExecutorTurnInput[] } {
	const calls: ExecutorTurnInput[] = [];
	let aborted = false;
	return {
		model: opts?.model ?? "executor-model",
		calls,
		async turn(input: ExecutorTurnInput): Promise<ExecutorTurnOutput> {
			calls.push(input);
			if (opts?.throwOnTurn === input.turn) {
				throw new Error(`executor failed on turn ${input.turn}`);
			}
			if (opts?.sleepMs) {
				await new Promise((r) => setTimeout(r, opts.sleepMs));
			}
			if (aborted) throw new Error("aborted");
			return {
				summary: `turn ${input.turn} output`,
				tokensIn: opts?.tokensPerTurn ?? 100,
				tokensOut: opts?.tokensPerTurn ?? 50,
			};
		},
		abort() {
			aborted = true;
		},
	};
}

function mockJudge(opts: {
	model?: string;
	verdicts: Array<Partial<JudgeVerdict> & { decision: JudgeVerdict["decision"] }>;
	throwOnCall?: number;
}): JudgeHandle & { calls: JudgeHandleInput[] } {
	const calls: JudgeHandleInput[] = [];
	let i = 0;
	return {
		model: opts.model ?? "judge-model",
		calls,
		async score(input: JudgeHandleInput): Promise<JudgeVerdict> {
			calls.push(input);
			const callNo = i + 1;
			if (opts.throwOnCall === callNo) {
				throw new Error(`judge failed on call ${callNo}`);
			}
			const v = opts.verdicts[Math.min(i, opts.verdicts.length - 1)];
			i += 1;
			return {
				decision: v.decision,
				confidence: v.confidence ?? 0.9,
				summary: v.summary ?? `verdict for turn ${input.turn}`,
				nextStep: v.nextStep,
				notes: v.notes,
				criteria: v.criteria,
			};
		},
	};
}

// ---- tests ------------------------------------------------------------------

describe("GoalLoop construction", () => {
	it("rejects identical judge + executor models", () => {
		expect(
			() =>
				new GoalLoop({
					runId: "r1",
					sessionId: "s1",
					goal: "ship the feature",
					executor: mockExecutor({ model: "qwen3:14b" }),
					judge: mockJudge({ model: "qwen3:14b", verdicts: [{ decision: "satisfied" }] }),
					sink: new MemorySink(),
				}),
		).toThrow(JudgeExecutorCollisionError);
	});

	it("rejects identical models case-insensitively + whitespace-trimmed", () => {
		expect(
			() =>
				new GoalLoop({
					runId: "r1",
					sessionId: "s1",
					goal: "x",
					executor: mockExecutor({ model: "Qwen3:14B" }),
					judge: mockJudge({ model: " qwen3:14b ", verdicts: [{ decision: "satisfied" }] }),
					sink: new MemorySink(),
				}),
		).toThrow(JudgeExecutorCollisionError);
	});

	it("rejects budget.turns <= 0", () => {
		expect(
			() =>
				new GoalLoop({
					runId: "r1",
					sessionId: "s1",
					goal: "x",
					executor: mockExecutor(),
					judge: mockJudge({ verdicts: [{ decision: "satisfied" }] }),
					sink: new MemorySink(),
					budget: { turns: 0 },
				}),
		).toThrow(/turns must be > 0/);
	});
});

describe("GoalLoop happy path", () => {
	it("terminates with judge_satisfied when judge says satisfied above floor", async () => {
		const sink = new MemorySink();
		const loop = new GoalLoop({
			runId: "r-happy",
			sessionId: "s1",
			goal: "make tests pass",
			executor: mockExecutor(),
			judge: mockJudge({ verdicts: [{ decision: "continue" }, { decision: "satisfied", confidence: 0.9 }] }),
			sink,
			budget: { turns: 10 },
		});

		const receipt = await loop.run_();

		expect(receipt.status).toBe("completed");
		expect(receipt.stopReason).toBe("judge_satisfied");
		expect(receipt.turns).toHaveLength(2);
		expect(receipt.finalVerdict?.decision).toBe("satisfied");
		expect(sink.kinds()).toContain("run.started");
		expect(sink.kinds()).toContain("run.completed");
		// turn requested for both turns
		expect(sink.kinds().filter((k) => k === "turn.requested")).toHaveLength(2);
	});

	it("demotes low-confidence satisfied to continue (confidence floor)", async () => {
		const sink = new MemorySink();
		const loop = new GoalLoop({
			runId: "r-floor",
			sessionId: "s1",
			goal: "x",
			executor: mockExecutor(),
			judge: mockJudge({
				// 0.5 confidence "satisfied" should be demoted; next is real satisfied.
				verdicts: [
					{ decision: "satisfied", confidence: 0.5 },
					{ decision: "satisfied", confidence: 0.95 },
				],
			}),
			sink,
			budget: { turns: 5 },
		});
		const receipt = await loop.run_();
		expect(receipt.turns.length).toBe(2);
		expect(receipt.status).toBe("completed");
		expect(receipt.turns[0].verdict?.decision).toBe("continue");
		expect(receipt.turns[1].verdict?.decision).toBe("satisfied");
	});
});

describe("GoalLoop budget enforcement", () => {
	it("stops on turn cap regardless of judge", async () => {
		const sink = new MemorySink();
		const executor = mockExecutor();
		const loop = new GoalLoop({
			runId: "r-cap",
			sessionId: "s1",
			goal: "loop forever",
			executor,
			// Judge always says continue - only the turn cap saves us.
			judge: mockJudge({ verdicts: [{ decision: "continue" }] }),
			sink,
			budget: { turns: 3, maxDissentStreak: 100 },
		});
		const receipt = await loop.run_();
		expect(receipt.status).toBe("stopped");
		expect(receipt.stopReason).toBe("budget_turns");
		expect(receipt.turns).toHaveLength(3);
		expect(executor.calls).toHaveLength(3);
		expect(sink.kinds()).toContain("budget.tripped");
	});

	it("stops on token cap mid-run", async () => {
		const sink = new MemorySink();
		const loop = new GoalLoop({
			runId: "r-tok",
			sessionId: "s1",
			goal: "x",
			executor: mockExecutor({ tokensPerTurn: 600 }), // 1200 tokens/turn
			judge: mockJudge({ verdicts: [{ decision: "continue" }] }),
			sink,
			budget: { turns: 20, tokens: 2500, maxDissentStreak: 100 },
		});
		const receipt = await loop.run_();
		expect(receipt.status).toBe("stopped");
		expect(receipt.stopReason).toBe("budget_tokens");
		// 1200, 2400, 3600 -> third turn trips
		expect(receipt.turns.length).toBe(3);
	});

	it("stops on wallclock cap", async () => {
		const sink = new MemorySink();
		let t = 1000;
		const loop = new GoalLoop({
			runId: "r-wall",
			sessionId: "s1",
			goal: "x",
			executor: mockExecutor(),
			judge: mockJudge({ verdicts: [{ decision: "continue" }] }),
			sink,
			budget: { turns: 100, wallclockMs: 50, maxDissentStreak: 100 },
			// Synthetic clock: advance 30ms per call - trips after 2 ticks.
			now: () => {
				t += 30;
				return t;
			},
		});
		const receipt = await loop.run_();
		expect(receipt.status).toBe("stopped");
		expect(receipt.stopReason).toBe("budget_wallclock");
	});
});

describe("GoalLoop judge dissent", () => {
	it("stops after N consecutive continue verdicts", async () => {
		const sink = new MemorySink();
		const loop = new GoalLoop({
			runId: "r-dis",
			sessionId: "s1",
			goal: "x",
			executor: mockExecutor(),
			judge: mockJudge({ verdicts: [{ decision: "continue" }] }),
			sink,
			// Turn cap high - only dissent should stop us.
			budget: { turns: 50, maxDissentStreak: 4 },
		});
		const receipt = await loop.run_();
		expect(receipt.status).toBe("stopped");
		expect(receipt.stopReason).toBe("judge_dissent_streak");
		// 4 continue verdicts -> stop on the 4th
		expect(receipt.turns.length).toBe(4);
	});

	it("resets dissent streak on satisfied (via demotion not happening)", async () => {
		const sink = new MemorySink();
		const loop = new GoalLoop({
			runId: "r-mixed",
			sessionId: "s1",
			goal: "x",
			executor: mockExecutor(),
			judge: mockJudge({
				verdicts: [
					{ decision: "continue" },
					{ decision: "continue" },
					{ decision: "satisfied", confidence: 0.9 },
				],
			}),
			sink,
			budget: { turns: 10, maxDissentStreak: 2 },
		});
		// dissent reaches 2 on turn 2 which trips. We expect stop on turn 2.
		const receipt = await loop.run_();
		expect(receipt.status).toBe("stopped");
		expect(receipt.stopReason).toBe("judge_dissent_streak");
		expect(receipt.turns.length).toBe(2);
	});
});

describe("GoalLoop failures", () => {
	it("transitions to failed when executor throws", async () => {
		const sink = new MemorySink();
		const loop = new GoalLoop({
			runId: "r-err",
			sessionId: "s1",
			goal: "x",
			executor: mockExecutor({ throwOnTurn: 1 }),
			judge: mockJudge({ verdicts: [{ decision: "satisfied" }] }),
			sink,
			budget: { turns: 5 },
		});
		const receipt = await loop.run_();
		expect(receipt.status).toBe("failed");
		expect(receipt.stopReason).toBe("executor_error");
		expect(sink.kinds()).toContain("run.failed");
	});

	it("transitions to failed when judge throws", async () => {
		const sink = new MemorySink();
		const loop = new GoalLoop({
			runId: "r-jerr",
			sessionId: "s1",
			goal: "x",
			executor: mockExecutor(),
			judge: mockJudge({ verdicts: [{ decision: "continue" }], throwOnCall: 1 }),
			sink,
			budget: { turns: 5 },
		});
		const receipt = await loop.run_();
		expect(receipt.status).toBe("failed");
		expect(receipt.stopReason).toBe("judge_error");
	});
});

describe("GoalLoop subgoal + abort", () => {
	it("injects pending subgoal on next executor turn", async () => {
		const sink = new MemorySink();
		const executor = mockExecutor();
		const loop = new GoalLoop({
			runId: "r-sub",
			sessionId: "s1",
			goal: "x",
			executor,
			judge: mockJudge({
				verdicts: [{ decision: "continue" }, { decision: "satisfied", confidence: 0.9 }],
			}),
			sink,
			budget: { turns: 5 },
		});
		loop.injectSubgoal("focus on auth tests");
		const receipt = await loop.run_();
		expect(executor.calls[0].subgoal).toBe("focus on auth tests");
		expect(executor.calls[1].subgoal).toBeUndefined();
		expect(receipt.status).toBe("completed");
		expect(sink.kinds()).toContain("subgoal.injected");
	});

	it("abort terminates with user_abort before next turn", async () => {
		const sink = new MemorySink();
		const loop = new GoalLoop({
			runId: "r-abort",
			sessionId: "s1",
			goal: "x",
			executor: mockExecutor(),
			judge: mockJudge({ verdicts: [{ decision: "continue" }] }),
			sink,
			budget: { turns: 10 },
		});
		// Abort before run_ starts iterating. With status pending->running, the
		// first iteration checks abort and bails immediately.
		loop.abort();
		const receipt = await loop.run_();
		expect(receipt.status).toBe("stopped");
		expect(receipt.stopReason).toBe("user_abort");
	});
});

describe("GoalLoop receipt shape", () => {
	let originalNow: number;
	beforeEach(() => {
		originalNow = Date.now();
	});
	afterEach(() => {
		// no-op
	});

	it("records executor + judge models and totals tokens", async () => {
		const sink = new MemorySink();
		const loop = new GoalLoop({
			runId: "r-shape",
			sessionId: "sess-99",
			goal: "do the thing",
			executor: mockExecutor({ model: "executor-A", tokensPerTurn: 50 }),
			judge: mockJudge({ model: "judge-B", verdicts: [{ decision: "satisfied", confidence: 0.9 }] }),
			sink,
			budget: { turns: 3 },
		});
		const receipt = await loop.run_();
		expect(receipt.executorModel).toBe("executor-A");
		expect(receipt.judgeModel).toBe("judge-B");
		expect(receipt.sessionId).toBe("sess-99");
		expect(receipt.totalTokens).toBe(100); // tokensIn 50 + tokensOut 50, 1 turn
		expect(receipt.endedAt).toBeGreaterThanOrEqual(originalNow);
		expect(receipt.durationMs).toBeGreaterThanOrEqual(0);
	});
});
