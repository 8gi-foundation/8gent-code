/**
 * improvement-loop.ts - End-to-end wiring for the self-improvement cycle.
 *
 * Connects three primitives that already existed independently:
 *   1. autoresearch iteration results (benchmarks/autoresearch/autoresearch-loop.ts)
 *   2. evolution-db event recording (./evolution-db.ts)
 *   3. learned-skills persistence (./learned-skills.ts)
 *   4. session reflection (./reflection.ts)
 *
 * Public surface is intentionally narrow:
 *   - recordIterationOutcome(prev, curr, mutationsAdded, sessionId)
 *       Diffs two iteration results. Failed benchmarks become error_encountered
 *       events. Score improvements tied to a mutation become learned skills.
 *   - reflectOnIterations(state, sessionId)
 *       Builds SessionData from accumulated iteration history and calls reflect().
 *   - runImprovementCycle({ before, after, mutations, sessionId })
 *       One-shot helper that performs both steps. Used by autoresearch-loop.ts
 *       and by the smoke test.
 */

import { recordEvent } from "./evolution-db.js";
import { learnSkill, reinforceSkill, getRelevantSkills } from "./learned-skills.js";
import { reflect, type SessionData } from "./reflection.js";
import type { SessionReflection } from "./evolution-db.js";

// ============================================
// Types - mirror autoresearch-loop.IterationResult so we don't import
// across the benchmarks/packages boundary.
// ============================================

export interface IterationResultLike {
	iteration: number;
	avgScore: number;
	passing: number;
	total: number;
	scores: Record<string, number>;
	mutationsAdded: string[];
	timestamp: string;
}

export interface IterationOutcome {
	/** Number of benchmarks that regressed compared to the previous iteration */
	regressions: number;
	/** Number of benchmarks that improved */
	improvements: number;
	/** evolution_events row IDs created during this call */
	eventIds: string[];
	/** learned_skill IDs persisted as a result of improvements */
	skillIds: string[];
}

// ============================================
// Step 1 - Record per-iteration outcomes into evolution-db
// ============================================

const PASS_THRESHOLD_DEFAULT = 80;

/**
 * After each benchmark iteration, persist failures and improvements.
 *
 * Failures: every benchmark below threshold gets an `error_encountered` event.
 * Improvements: every benchmark whose score grew vs the previous iteration is
 * persisted as a learned skill keyed by benchmark id, and a confidence_change
 * event is emitted.
 *
 * If `prev` is null (first iteration), only failures are recorded.
 */
export function recordIterationOutcome(
	prev: IterationResultLike | null,
	curr: IterationResultLike,
	sessionId: string,
	passThreshold: number = PASS_THRESHOLD_DEFAULT,
): IterationOutcome {
	const eventIds: string[] = [];
	const skillIds: string[] = [];
	let regressions = 0;
	let improvements = 0;

	for (const [benchmarkId, score] of Object.entries(curr.scores)) {
		const prevScore = prev?.scores[benchmarkId] ?? null;

		// Record failures so the agent knows what still hurts
		if (score < passThreshold) {
			const id = recordEvent({
				sessionId,
				eventType: "error_encountered",
				subject: benchmarkId,
				value: score,
				metadata: {
					iteration: curr.iteration,
					prevScore,
					mutationsActive: curr.mutationsAdded.length,
				},
			});
			eventIds.push(id);
		}

		// Detect regressions for stagnation analysis
		if (prevScore !== null && score < prevScore) {
			regressions++;
			const id = recordEvent({
				sessionId,
				eventType: "confidence_change",
				subject: benchmarkId,
				value: score - prevScore,
				metadata: { direction: "regression", iteration: curr.iteration },
			});
			eventIds.push(id);
		}

		// Improvements: persist as learned skills + confidence_change event
		if (prevScore !== null && score > prevScore) {
			improvements++;
			// Tie the improvement to the mutation that triggered it. The most
			// recently added mutation for this benchmark id is the best guess.
			const trigger = `benchmark:${benchmarkId} score regressed below ${passThreshold}`;
			const matchingMutation =
				curr.mutationsAdded.find((m) => m.includes(`[${benchmarkId}]`)) ??
				curr.mutationsAdded[curr.mutationsAdded.length - 1] ??
				`Iteration ${curr.iteration} general improvement`;

			const skill = learnSkill(trigger, matchingMutation, "autoresearch");
			skillIds.push(skill.id);

			// Reinforce the skill confidence in proportion to score gain
			if (score - prevScore >= 10) reinforceSkill(skill.id, true);

			const evtId = recordEvent({
				sessionId,
				eventType: "confidence_change",
				subject: benchmarkId,
				value: score - prevScore,
				metadata: {
					direction: "improvement",
					iteration: curr.iteration,
					skillId: skill.id,
				},
			});
			eventIds.push(evtId);
		}
	}

	return { regressions, improvements, eventIds, skillIds };
}

// ============================================
// Step 2 - Run reflection between iterations
// ============================================

export interface ReflectionInput {
	sessionId: string;
	history: IterationResultLike[];
	mutations: string[];
}

/**
 * Build a SessionData from accumulated iteration history and run reflect().
 * Reuses the existing reflection.ts module - no parallel implementation.
 */
export function reflectOnIterations(input: ReflectionInput): SessionReflection {
	const { sessionId, history, mutations } = input;

	// Aggregate "tools used" as the set of distinct benchmark categories surfaced
	// in this run. Reflection is benchmark-agnostic; categories act as proxies
	// for which subsystems were exercised.
	const benchmarkIds = new Set<string>();
	const errors: string[] = [];
	let successfulCalls = 0;
	let totalCalls = 0;

	for (const iter of history) {
		for (const [id, score] of Object.entries(iter.scores)) {
			benchmarkIds.add(id);
			totalCalls++;
			if (score >= PASS_THRESHOLD_DEFAULT) {
				successfulCalls++;
			} else {
				errors.push(`${id} scored ${score} on iter ${iter.iteration}`);
			}
		}
	}

	// Mutations become "notes" so reflect() can extract patterns from them.
	const notes = mutations.map((m) => `PATTERN: ${m}`);

	const sessionData: SessionData = {
		sessionId,
		toolsUsed: [...benchmarkIds],
		errors,
		notes,
		successfulCalls,
		totalCalls,
	};

	return reflect(sessionData);
}

// ============================================
// Step 3 - Convenience wrapper for one full cycle
// ============================================

export interface CycleInput {
	sessionId: string;
	before: IterationResultLike | null;
	after: IterationResultLike;
	allHistory: IterationResultLike[];
	allMutations: string[];
	passThreshold?: number;
}

export interface CycleOutput {
	outcome: IterationOutcome;
	reflection: SessionReflection;
}

/**
 * Run one full self-improvement cycle:
 *   1. record what changed in evolution-db
 *   2. reflect on the cumulative history
 *
 * Returns both for inspection. Callers can ignore the return value when they
 * only care about side effects on the DB.
 */
export function runImprovementCycle(input: CycleInput): CycleOutput {
	const outcome = recordIterationOutcome(
		input.before,
		input.after,
		input.sessionId,
		input.passThreshold ?? PASS_THRESHOLD_DEFAULT,
	);

	const reflection = reflectOnIterations({
		sessionId: input.sessionId,
		history: input.allHistory,
		mutations: input.allMutations,
	});

	return { outcome, reflection };
}

/**
 * Helper for callers that want to surface the most relevant learned skills
 * for the next iteration's prompt context.
 */
export function getSkillsForNextIteration(taskHint: string, limit = 3): string {
	const skills = getRelevantSkills(taskHint, limit);
	if (skills.length === 0) return "";
	return skills.map((s) => `- ${s.action} [${(s.confidence * 100).toFixed(0)}%]`).join("\n");
}
