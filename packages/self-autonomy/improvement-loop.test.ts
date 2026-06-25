/**
 * Smoke test for the end-to-end self-improvement loop.
 *
 * Simulates two consecutive autoresearch iterations:
 *   - iter 1: benchmark FOO scores 40 (failing)
 *   - iter 2: benchmark FOO scores 90 (passing) after a mutation was added
 *
 * Asserts:
 *   - failure events landed in evolution_events with type=error_encountered
 *   - improvement was persisted as a learned_skill
 *   - confidence_change events were recorded for both regression and improvement
 *   - reflectOnIterations() returned a SessionReflection with the expected fields
 *
 * This is the cycle described in docs/HYPERAGENT-SPEC.md.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getAllSkills, getDb, getEvolutionSummary, resetDb } from "./evolution-db";
import {
	type IterationResultLike,
	recordIterationOutcome,
	reflectOnIterations,
	runImprovementCycle,
} from "./improvement-loop";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "improvement-loop-test-"));
	process.env.EIGHT_DATA_DIR = tmpDir;
	resetDb();
});

afterEach(() => {
	resetDb();
	fs.rmSync(tmpDir, { recursive: true, force: true });
	process.env.EIGHT_DATA_DIR = undefined;
});

describe("recordIterationOutcome", () => {
	it("persists failures as error_encountered events", () => {
		const curr: IterationResultLike = {
			iteration: 1,
			avgScore: 40,
			passing: 0,
			total: 1,
			scores: { FOO: 40 },
			mutationsAdded: [],
			timestamp: new Date().toISOString(),
		};

		const outcome = recordIterationOutcome(null, curr, "smoke-1");

		expect(outcome.eventIds.length).toBeGreaterThan(0);

		const db = getDb();
		const errors = db
			.prepare("SELECT subject, value FROM evolution_events WHERE event_type = 'error_encountered'")
			.all() as any[];
		expect(errors.length).toBe(1);
		expect(errors[0].subject).toBe("FOO");
		expect(errors[0].value).toBe(40);
	});

	it("persists score improvements as learned skills", () => {
		const before: IterationResultLike = {
			iteration: 1,
			avgScore: 40,
			passing: 0,
			total: 1,
			scores: { FOO: 40 },
			mutationsAdded: [],
			timestamp: new Date().toISOString(),
		};

		const after: IterationResultLike = {
			iteration: 2,
			avgScore: 90,
			passing: 1,
			total: 1,
			scores: { FOO: 90 },
			mutationsAdded: ["[FOO] Always validate input before parsing."],
			timestamp: new Date().toISOString(),
		};

		const outcome = recordIterationOutcome(before, after, "smoke-2");

		expect(outcome.improvements).toBe(1);
		expect(outcome.regressions).toBe(0);
		expect(outcome.skillIds.length).toBe(1);

		const skills = getAllSkills();
		expect(skills.length).toBe(1);
		expect(skills[0].action).toContain("[FOO]");
		expect(skills[0].source).toBe("autoresearch");
		// Big score gain (50 points) → reinforced confidence
		expect(skills[0].confidence).toBeGreaterThan(0.5);
	});

	it("records regressions with negative confidence_change", () => {
		const before: IterationResultLike = {
			iteration: 1,
			avgScore: 90,
			passing: 1,
			total: 1,
			scores: { FOO: 90 },
			mutationsAdded: [],
			timestamp: new Date().toISOString(),
		};

		const after: IterationResultLike = {
			iteration: 2,
			avgScore: 60,
			passing: 0,
			total: 1,
			scores: { FOO: 60 },
			mutationsAdded: ["[FOO] bad mutation"],
			timestamp: new Date().toISOString(),
		};

		const outcome = recordIterationOutcome(before, after, "smoke-3");
		expect(outcome.regressions).toBe(1);
		expect(outcome.improvements).toBe(0);

		const db = getDb();
		const changes = db
			.prepare(
				"SELECT value, metadata FROM evolution_events WHERE event_type = 'confidence_change'",
			)
			.all() as any[];
		expect(changes.length).toBe(1);
		expect(changes[0].value).toBe(-30);
	});
});

describe("reflectOnIterations", () => {
	it("aggregates iteration history into a SessionReflection", () => {
		const history: IterationResultLike[] = [
			{
				iteration: 1,
				avgScore: 40,
				passing: 0,
				total: 2,
				scores: { FOO: 40, BAR: 90 },
				mutationsAdded: [],
				timestamp: new Date().toISOString(),
			},
			{
				iteration: 2,
				avgScore: 90,
				passing: 2,
				total: 2,
				scores: { FOO: 90, BAR: 95 },
				mutationsAdded: ["[FOO] validate input"],
				timestamp: new Date().toISOString(),
			},
		];

		const reflection = reflectOnIterations({
			sessionId: "smoke-reflect",
			history,
			mutations: ["[FOO] validate input"],
		});

		expect(reflection.sessionId).toBe("smoke-reflect");
		expect(reflection.toolsUsed).toContain("FOO");
		expect(reflection.toolsUsed).toContain("BAR");
		// 3 of 4 benchmark/iteration pairs passed
		expect(reflection.successRate).toBeCloseTo(3 / 4, 2);
		// Mutation was promoted to a pattern via the PATTERN: prefix
		expect(reflection.patternsObserved.some((p) => p.includes("validate input"))).toBe(true);
	});
});

describe("runImprovementCycle (full E2E)", () => {
	it("runs benchmark fail → mutate → re-test → persist in one cycle", () => {
		const sessionId = "smoke-e2e";

		// Iteration 1: benchmark fails
		const iter1: IterationResultLike = {
			iteration: 1,
			avgScore: 40,
			passing: 0,
			total: 1,
			scores: { FOO: 40 },
			mutationsAdded: [],
			timestamp: new Date().toISOString(),
		};

		// Iteration 2: mutation added, benchmark improves
		const iter2: IterationResultLike = {
			iteration: 2,
			avgScore: 90,
			passing: 1,
			total: 1,
			scores: { FOO: 90 },
			mutationsAdded: ["[FOO] Always validate input before parsing."],
			timestamp: new Date().toISOString(),
		};

		// Cycle 1: fail-only iteration
		const cycle1 = runImprovementCycle({
			sessionId,
			before: null,
			after: iter1,
			allHistory: [iter1],
			allMutations: [],
		});
		expect(cycle1.outcome.eventIds.length).toBeGreaterThan(0);
		expect(cycle1.reflection.successRate).toBeCloseTo(0, 2);

		// Cycle 2: improvement persists as a skill
		const cycle2 = runImprovementCycle({
			sessionId,
			before: iter1,
			after: iter2,
			allHistory: [iter1, iter2],
			allMutations: ["[FOO] Always validate input before parsing."],
		});

		expect(cycle2.outcome.improvements).toBe(1);
		expect(cycle2.outcome.skillIds.length).toBe(1);

		// Final assertions: DB has the right state
		const skills = getAllSkills();
		expect(skills.length).toBe(1);
		expect(skills[0].action).toContain("[FOO]");

		const since = new Date(Date.now() - 60_000).toISOString();
		const summary = getEvolutionSummary(since);
		expect(summary.errorRate).toBeGreaterThan(0); // first iteration recorded an error
		expect(summary.improvedSkills + summary.degradedSkills).toBeGreaterThan(0);
	});
});

// ============================================================
// Tests for Step 4 — Loop Stop Conditions  (issue #2700)
// ============================================================

import {
	type LoopStopCondition,
	initLoopState,
	shouldStop,
	RegexGoalEvaluator,
	LoopController,
	runBoundedLoop,
} from "./improvement-loop";

function makeIter(avgScore: number, mutations: string[] = []): import("./improvement-loop").IterationResultLike {
	return {
		iteration: 0,
		avgScore,
		passing: avgScore >= 80 ? 1 : 0,
		total: 1,
		scores: { FOO: avgScore },
		mutationsAdded: mutations,
		timestamp: new Date().toISOString(),
	};
}

describe("shouldStop", () => {
	it("returns stop=false on fresh state with no limits", () => {
		const state = initLoopState();
		const result = shouldStop(state, {}, 0);
		expect(result.stop).toBe(false);
	});

	it("stops on max_turns", () => {
		const state = { ...initLoopState(), turns: 10 };
		const result = shouldStop(state, { maxTurns: 10 }, 0);
		expect(result.stop).toBe(true);
		expect(result.reason?.type).toBe("max_turns");
	});

	it("stops on goal_score_threshold", () => {
		const state = initLoopState();
		const result = shouldStop(state, { goalScoreThreshold: 95 }, 96);
		expect(result.stop).toBe(true);
		expect(result.reason?.type).toBe("goal_score_threshold");
	});

	it("does NOT stop when score is below threshold", () => {
		const state = initLoopState();
		const result = shouldStop(state, { goalScoreThreshold: 95 }, 80);
		expect(result.stop).toBe(false);
	});

	it("stops on max_tokens", () => {
		const state = { ...initLoopState(), totalTokens: 90_000 };
		const result = shouldStop(state, { maxTokens: 100_000 }, 50, 15_000);
		expect(result.stop).toBe(true);
		expect(result.reason?.type).toBe("max_tokens");
	});

	it("stops on stall", () => {
		const state = { ...initLoopState(), stallCount: 3 };
		const result = shouldStop(state, { maxStallCount: 3 }, 50);
		expect(result.stop).toBe(true);
		expect(result.reason?.type).toBe("stalled");
	});

	it("stall check is exclusive: stallCount == limit - 1 means keep going", () => {
		const state = { ...initLoopState(), stallCount: 2 };
		const result = shouldStop(state, { maxStallCount: 3 }, 50);
		expect(result.stop).toBe(false);
	});

	it("goal_score_threshold takes priority over max_turns", () => {
		// Both are true but goal_met should win
		const state = { ...initLoopState(), turns: 10 };
		const result = shouldStop(state, { maxTurns: 10, goalScoreThreshold: 95 }, 98);
		expect(result.stop).toBe(true);
		expect(result.reason?.type).toBe("goal_score_threshold");
	});
});

describe("RegexGoalEvaluator", () => {
	it("returns true when evidence contains '0 failed'", async () => {
		const ev = new RegexGoalEvaluator();
		const result = await ev.evaluate("all tests pass", ["Running tests...", "0 failed", "Done"], "s1");
		expect(result).toBe(true);
	});

	it("returns false when no pass indicators present", async () => {
		const ev = new RegexGoalEvaluator();
		const result = await ev.evaluate("all tests pass", ["Running tests...", "3 failed"], "s1");
		expect(result).toBe(false);
	});

	it("handles lint clean goal", async () => {
		const ev = new RegexGoalEvaluator();
		const result = await ev.evaluate("lint is clean", ["ESLint: 0 errors"], "s1");
		expect(result).toBe(true);
	});

	it("fallback: goal text as search term", async () => {
		const ev = new RegexGoalEvaluator();
		const result = await ev.evaluate("deploy-ready", ["Status: deploy-ready"], "s1");
		expect(result).toBe(true);
	});
});

describe("LoopController", () => {
	it("starts with stopped=false", () => {
		const ctrl = new LoopController();
		expect(ctrl.stopped).toBe(false);
		expect(ctrl.stopReason).toBeUndefined();
	});

	it("stops after maxTurns iterations", () => {
		const ctrl = new LoopController({ maxTurns: 3 });
		for (let i = 0; i < 3; i++) {
			ctrl.advance(makeIter(50));
			expect(ctrl.stopped).toBe(false); // stops AFTER the 3rd advance
		}
		ctrl.advance(makeIter(50));
		expect(ctrl.stopped).toBe(true);
		expect(ctrl.stopReason?.type).toBe("max_turns");
	});

	it("stops early when goal_score_threshold is met", () => {
		const ctrl = new LoopController({ goalScoreThreshold: 95 });
		ctrl.advance(makeIter(40));
		expect(ctrl.stopped).toBe(false);
		ctrl.advance(makeIter(98));
		expect(ctrl.stopped).toBe(true);
		expect(ctrl.stopReason?.type).toBe("goal_score_threshold");
	});

	it("increments stall count when score does not improve", () => {
		const ctrl = new LoopController({ maxStallCount: 2 });
		ctrl.advance(makeIter(40)); // 0 stalls (prevAvg = null)
		expect(ctrl.currentState.stallCount).toBe(0);
		ctrl.advance(makeIter(40)); // score same → stall
		expect(ctrl.currentState.stallCount).toBe(1);
		ctrl.advance(makeIter(40)); // stall again → stop
		expect(ctrl.stopped).toBe(true);
		expect(ctrl.stopReason?.type).toBe("stalled");
	});

	it("resets stall count when score improves", () => {
		const ctrl = new LoopController({ maxStallCount: 2 });
		ctrl.advance(makeIter(40));
		ctrl.advance(makeIter(40)); // stall = 1
		expect(ctrl.currentState.stallCount).toBe(1);
		ctrl.advance(makeIter(45)); // improved → stall reset
		expect(ctrl.currentState.stallCount).toBe(0);
		ctrl.advance(makeIter(40)); // stall = 1 again
		expect(ctrl.currentState.stallCount).toBe(1);
	});

	it("tracks totalTokens when tokensUsed is provided", () => {
		const ctrl = new LoopController({ maxTokens: 50_000 });
		ctrl.advance(makeIter(50), 30_000);
		expect(ctrl.currentState.totalTokens).toBe(30_000);
		ctrl.advance(makeIter(50), 30_000); // should trigger max_tokens
		expect(ctrl.stopped).toBe(true);
		expect(ctrl.stopReason?.type).toBe("max_tokens");
	});

	it("summary() returns correct shape", () => {
		const ctrl = new LoopController({ maxTurns: 1 });
		ctrl.advance(makeIter(85, ["[FOO] fix"]));
		ctrl.advance(makeIter(85, ["[FOO] fix"])); // triggers stop
		const s = ctrl.summary();
		expect(s.stopped).toBe(true);
		expect(s.reason?.type).toBe("max_turns");
		expect(s.iterations).toBe(2);
		expect(s.finalScore).toBe(85);
		expect(s.skillsLearned).toBe(2);
	});

	it("currentContext() returns turn + history", () => {
		const ctrl = new LoopController();
		ctrl.advance(makeIter(50));
		ctrl.advance(makeIter(60));
		const ctx = ctrl.currentContext();
		expect(ctx.turn).toBe(2);
		expect(ctx.history.length).toBe(2);
		expect(ctx.history[0].avgScore).toBe(50);
		expect(ctx.history[1].avgScore).toBe(60);
	});
});

describe("runBoundedLoop (async shortcut)", () => {
	it("runs exactly maxTurns iterations then returns summary", async () => {
		let callCount = 0;
		const summary = await runBoundedLoop({ maxTurns: 4 }, async ({ turn }) => {
			callCount++;
			return { result: makeIter(50 + turn) };
		});
		expect(callCount).toBe(4);
		expect(summary.stopped).toBe(true);
		expect(summary.reason?.type).toBe("max_turns");
		expect(summary.iterations).toBe(4);
	});

	it("exits early when goal_score_threshold is met", async () => {
		let callCount = 0;
		const summary = await runBoundedLoop({ maxTurns: 20, goalScoreThreshold: 90 }, async ({ turn }) => {
			callCount++;
			return { result: makeIter(turn > 2 ? 95 : 50) };
		});
		expect(callCount).toBe(3); // turn 0 (50), turn 1 (50), turn 2 (95 → stop)
		expect(summary.reason?.type).toBe("goal_score_threshold");
		expect(summary.finalScore).toBe(95);
	});
});
