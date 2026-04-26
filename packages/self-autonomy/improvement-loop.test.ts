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
