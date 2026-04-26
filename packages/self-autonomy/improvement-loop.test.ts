/**
 * End-to-end smoke test for the self-improvement loop (issue #1911).
 *
 * Simulates two autoresearch iterations on a synthetic benchmark:
 *   iter 1: score=40 (below threshold), mutation proposed
 *   iter 2: score=85 (improved over iter 1, above threshold)
 *
 * Verifies:
 *   - iter 1 lands a confidence_change + error_encountered event
 *   - iter 2 lands a confidence_change + skill_learned event
 *   - the proposed mutation is now persisted as a learned skill with
 *     non-zero confidence in the DB
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	getEvolutionSummary,
	getPatternFrequency,
	getSkillHistory,
	resetDb,
} from "./evolution-db";
import { getRelevantSkills } from "./learned-skills";
import { recordIterationOutcome, runReflectionBetweenIterations } from "./improvement-loop";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "improvement-loop-"));
	process.env.EIGHT_DATA_DIR = tmpDir;
	resetDb();
});

afterEach(() => {
	resetDb();
	fs.rmSync(tmpDir, { recursive: true, force: true });
	process.env.EIGHT_DATA_DIR = undefined;
});

describe("recordIterationOutcome", () => {
	it("records a failure event and emits a confidence_change for a sub-threshold benchmark", () => {
		const sessionId = "iter1";

		recordIterationOutcome({
			sessionId,
			iteration: 1,
			currAvgScore: 40,
			passThreshold: 80,
			benchmarks: [
				{
					benchmarkId: "FS001",
					category: "fullstack",
					score: 40,
					mutations: ["Always include the auth middleware in the request pipeline."],
					failingPrompt: "Build an auth system",
				},
			],
		});

		const subject = "bench:fullstack:FS001";
		const since = new Date(Date.now() - 60_000).toISOString();
		const summary = getEvolutionSummary(since);

		expect(summary.newSkills).toBe(0); // no skill learned yet - score didn't improve
		// Confidence event recorded for first iteration
		const confidenceHistory = getSkillHistory(subject);
		expect(confidenceHistory.length).toBe(1);
		expect(confidenceHistory[0].confidence).toBeCloseTo(0.4, 4);
	});

	it("persists a mutation as a learned skill when score improves", () => {
		const subject = "bench:fullstack:FS001";

		// Iteration 1 - score 40, fails
		recordIterationOutcome({
			sessionId: "iter1",
			iteration: 1,
			currAvgScore: 40,
			passThreshold: 80,
			benchmarks: [
				{
					benchmarkId: "FS001",
					category: "fullstack",
					score: 40,
					mutations: ["Always include the auth middleware."],
					failingPrompt: "Build an auth system",
				},
			],
		});

		// Iteration 2 - score 85, improvement
		const report = recordIterationOutcome({
			sessionId: "iter2",
			iteration: 2,
			prevAvgScore: 40,
			currAvgScore: 85,
			passThreshold: 80,
			benchmarks: [
				{
					benchmarkId: "FS001",
					category: "fullstack",
					score: 85,
					previousScore: 40,
					mutations: ["Always include the auth middleware."],
				},
			],
		});

		expect(report.improvedCount).toBe(1);
		expect(report.failedCount).toBe(0);
		expect(report.skillsLearned.length).toBe(1);
		expect(report.skillsLearned[0].trigger).toBe(subject);
		expect(report.skillsLearned[0].action).toContain("auth middleware");

		// Score history contains both iterations, in order
		const confidenceHistory = getSkillHistory(subject);
		expect(confidenceHistory.length).toBe(2);
		expect(confidenceHistory[0].confidence).toBeCloseTo(0.4, 4);
		expect(confidenceHistory[1].confidence).toBeCloseTo(0.85, 4);

		// The skill is now searchable by trigger fragment
		const matches = getRelevantSkills("fullstack FS001", 5);
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0].trigger).toBe(subject);
	});

	it("reinforces existing skills negatively on regression with no new mutation", () => {
		// Seed a learned skill at iter 1 (improvement)
		recordIterationOutcome({
			sessionId: "seed",
			iteration: 1,
			currAvgScore: 90,
			passThreshold: 80,
			benchmarks: [
				{
					benchmarkId: "FS002",
					category: "fullstack",
					score: 90,
					previousScore: 50,
					mutations: ["Sort queue by priority."],
				},
			],
		});
		const seeded = getRelevantSkills("FS002", 1)[0];
		expect(seeded).toBeDefined();
		const seededConfidence = seeded.confidence;

		// Iter 2 - score regresses, no new mutation
		const report = recordIterationOutcome({
			sessionId: "regress",
			iteration: 2,
			prevAvgScore: 90,
			currAvgScore: 60,
			passThreshold: 80,
			benchmarks: [
				{
					benchmarkId: "FS002",
					category: "fullstack",
					score: 60,
					previousScore: 90,
					mutations: [],
				},
			],
		});

		expect(report.regressedCount).toBe(1);
		expect(report.failedCount).toBe(1);
		expect(report.skillsReinforced).toBeGreaterThanOrEqual(1);

		const after = getRelevantSkills("FS002", 1)[0];
		expect(after.confidence).toBeLessThan(seededConfidence);
	});
});

describe("full autonomous improvement cycle", () => {
	it("runs failure → mutation → improvement → skill persistence end-to-end", () => {
		const benchmarkId = "FS003";
		const category = "fullstack";
		const subject = `bench:${category}:${benchmarkId}`;

		// Cycle step 1: benchmark fails on iter 1
		const failPrompt = "Implement a state machine with transitions and guards";
		const failingMutation =
			"State machine: check guard fn, run action, update state, return success.";

		const r1 = recordIterationOutcome({
			sessionId: "cycle_iter1",
			iteration: 1,
			currAvgScore: 30,
			passThreshold: 80,
			benchmarks: [
				{
					benchmarkId,
					category,
					score: 30,
					mutations: [failingMutation],
					failingPrompt: failPrompt,
				},
			],
		});

		// Reflection between iterations - heartbeat would normally call this.
		runReflectionBetweenIterations({
			sessionId: "cycle_reflect_1",
			toolsUsed: ["read_file", "edit_file", "bash"],
			errors: ["TypeError: cannot read property 'state' of undefined"],
			notes: ["PATTERN: state machine missing guard check", "SKILL: always-run-guard-first"],
			successfulCalls: 5,
			totalCalls: 8,
		});

		expect(r1.failedCount).toBe(1);
		expect(r1.skillsLearned.length).toBe(0);

		// Cycle step 2: same benchmark improves on iter 2 with the same mutation
		const r2 = recordIterationOutcome({
			sessionId: "cycle_iter2",
			iteration: 2,
			prevAvgScore: 30,
			currAvgScore: 90,
			passThreshold: 80,
			benchmarks: [
				{
					benchmarkId,
					category,
					score: 90,
					previousScore: 30,
					mutations: [failingMutation],
				},
			],
		});

		expect(r2.improvedCount).toBe(1);
		expect(r2.skillsLearned.length).toBe(1);

		// Verifications across the full cycle
		const skills = getRelevantSkills(`${category} ${benchmarkId}`, 5);
		expect(skills.length).toBeGreaterThan(0);
		expect(skills[0].trigger).toBe(subject);
		expect(skills[0].action).toBe(failingMutation);

		const history = getSkillHistory(subject);
		expect(history.length).toBe(2);
		expect(history[0].confidence).toBeCloseTo(0.3, 4);
		expect(history[1].confidence).toBeCloseTo(0.9, 4);

		const since = new Date(Date.now() - 60_000).toISOString();
		const summary = getEvolutionSummary(since);
		expect(summary.newSkills).toBe(1);
		// Both iters produced confidence_change events with positive value (raw scores)
		expect(summary.improvedSkills).toBeGreaterThanOrEqual(1);
		// One iter under threshold = one error event
		expect(summary.errorRate).toBeGreaterThan(0);
	});
});
