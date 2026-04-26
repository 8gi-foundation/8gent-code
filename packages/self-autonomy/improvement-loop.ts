/**
 * Improvement Loop - wires benchmark iterations into the evolution DB.
 *
 * After each autoresearch iteration we are handed:
 *   - the previous and current average scores
 *   - per-benchmark scores (this iteration and last)
 *   - the mutations that were proposed during this iteration
 *
 * For each benchmark we decide one of three actions and persist it:
 *   1) regression or below pass threshold  → record failure event
 *   2) score improved over previous run    → persist mutation as learned skill
 *   3) flat / passing                      → record a flat confidence event only
 *
 * No new tables. No new files. We only call into evolution-db and
 * learned-skills, both of which already exist.
 */
import { recordEvent } from "./evolution-db.js";
import type { LearnedSkill } from "./evolution-db.js";
import { getRelevantSkills, learnSkill, reinforceSkill } from "./learned-skills.js";
import { reflect } from "./reflection.js";
import type { SessionData } from "./reflection.js";

// ============================================
// Types
// ============================================

export interface BenchmarkOutcome {
	/** Stable benchmark id, e.g. "FS001". Used as skill trigger. */
	benchmarkId: string;
	/** Free-form category, e.g. "fullstack". */
	category: string;
	/** Score this iteration, 0..100. */
	score: number;
	/** Score last iteration, 0..100. Undefined on iteration 1. */
	previousScore?: number;
	/** Mutations the loop proposed for this benchmark this iteration. */
	mutations: string[];
	/** Optional: original failing prompt text, only used on failures. */
	failingPrompt?: string;
}

export interface IterationOutcome {
	sessionId: string;
	iteration: number;
	prevAvgScore?: number;
	currAvgScore: number;
	passThreshold: number;
	benchmarks: BenchmarkOutcome[];
}

export interface IterationOutcomeReport {
	improvedCount: number;
	regressedCount: number;
	failedCount: number;
	skillsLearned: LearnedSkill[];
	skillsReinforced: number;
}

// ============================================
// Public API
// ============================================

/**
 * Persist the result of one autoresearch iteration into the evolution DB.
 * Safe to call repeatedly; each benchmark produces exactly one event row.
 */
export function recordIterationOutcome(outcome: IterationOutcome): IterationOutcomeReport {
	const report: IterationOutcomeReport = {
		improvedCount: 0,
		regressedCount: 0,
		failedCount: 0,
		skillsLearned: [],
		skillsReinforced: 0,
	};

	for (const b of outcome.benchmarks) {
		const passed = b.score >= outcome.passThreshold;
		const improved = typeof b.previousScore === "number" && b.score > b.previousScore;
		const regressed = typeof b.previousScore === "number" && b.score < b.previousScore;
		const delta =
			typeof b.previousScore === "number" ? (b.score - b.previousScore) / 100 : 0;

		// 1) Always emit a confidence_change event so getSkillHistory
		//    can plot per-benchmark progress over iterations.
		recordEvent({
			sessionId: outcome.sessionId,
			eventType: "confidence_change",
			subject: skillIdFor(b),
			value: b.score / 100,
			metadata: {
				iteration: outcome.iteration,
				category: b.category,
				delta,
				passed,
			},
		});

		// 2) Failure path - record the failing prompt + first mutation candidate
		//    so a future run can search the DB for "what did we try last time?"
		if (!passed) {
			report.failedCount += 1;
			recordEvent({
				sessionId: outcome.sessionId,
				eventType: "error_encountered",
				subject: skillIdFor(b),
				value: b.score / 100,
				metadata: {
					iteration: outcome.iteration,
					category: b.category,
					failingPrompt: b.failingPrompt ?? "",
					mutationCandidate: b.mutations[0] ?? "",
					mutationCount: b.mutations.length,
				},
			});
		}

		if (regressed) {
			report.regressedCount += 1;
		}

		// 3) Success path - if score improved AND we proposed a mutation,
		//    persist that mutation as a learned skill.
		//    The trigger is the benchmark id; the action is the mutation text.
		//    If the skill already exists it gets reinforced (confidence bumped).
		if (improved && b.mutations.length > 0) {
			report.improvedCount += 1;
			const action = b.mutations.join("\n");
			const beforeId = skillIdFor(b);
			const skill = learnSkill(
				skillIdFor(b),
				action,
				`autoresearch:iter${outcome.iteration}`,
			);
			report.skillsLearned.push(skill);
			recordEvent({
				sessionId: outcome.sessionId,
				eventType: "skill_learned",
				subject: beforeId,
				value: b.score / 100,
				metadata: {
					iteration: outcome.iteration,
					category: b.category,
					mutationCount: b.mutations.length,
				},
			});
		} else if (improved && b.mutations.length === 0) {
			// Improvement without a new mutation = an existing skill helped.
			// Reinforce any prior skill at this benchmark id.
			reinforcePriorSkill(skillIdFor(b), true);
			report.skillsReinforced += 1;
		} else if (regressed) {
			// Regression with no new mutation means a prior skill is hurting us.
			reinforcePriorSkill(skillIdFor(b), false);
			report.skillsReinforced += 1;
		}
	}

	return report;
}

/**
 * Run reflection between iterations. Thin wrapper so callers do not need
 * to import reflection.ts directly. Returns the persisted reflection.
 */
export function runReflectionBetweenIterations(sessionData: SessionData) {
	return reflect(sessionData);
}

// ============================================
// Helpers
// ============================================

function skillIdFor(b: BenchmarkOutcome): string {
	// Stable per-benchmark id used as both event subject and skill trigger.
	return `bench:${b.category}:${b.benchmarkId}`;
}

/**
 * Skills are stored with a UUID id but the autoresearch loop addresses
 * them by trigger. Resolve the most relevant skill at this trigger and
 * reinforce by uuid. No-op if no prior skill exists.
 */
function reinforcePriorSkill(trigger: string, success: boolean): void {
	const candidates = getRelevantSkills(trigger, 5);
	const exact = candidates.find((c) => c.trigger === trigger);
	if (exact) reinforceSkill(exact.id, success);
}
