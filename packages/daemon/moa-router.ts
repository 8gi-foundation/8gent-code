/**
 * MoA router - learned, per-task-class model choice for the MoA build verb.
 *
 * Step 2 of issue #2751. Step 1 landed the streaming dispatch verb
 * (`moa-verb.ts`), but the pipeline it wraps still picks a model per stage from
 * a STATIC `roles.json` (`loadRoleConfig()`). That is the hardcoded choice the
 * frontier work removes: a model that is strong at planning is not necessarily
 * strong at writing code, and the right arm for each class should be EARNED, not
 * fixed by config.
 *
 * This module wires the per-capability-class bandit (`packages/providers/
 * router-bandit.ts`, shipped by #2762) into the MoA pipeline as two seams:
 *
 *   - `chooseModel(role, candidates)` - a selector the pipeline consults before
 *     running a stage. It maps the stage's role to a capability class and asks
 *     the bandit to pick (Thompson sampling) among the models the pipeline says
 *     are actually reachable on this host right now. The candidate set is the
 *     live roster, so "no hardcoded model choice" stays honest: only the RANKING
 *     is learned here, never the existence of an arm.
 *   - `recordStages(stages)` - folds the pipeline's own per-stage ledger back
 *     into the bandit as reward, so the next build routes on real evidence.
 *
 * Everything is local-first and deterministic under an injected RNG: the bandit
 * touches only a JSON document under `~/.8gent`, no network and no cloud. When a
 * router is absent the pipeline falls back to `roles.json` exactly as before, so
 * this is additive and back-compatible.
 */

import type { StageRecord } from "../orchestration/adaptive-pipeline";
import type { RoleName } from "../orchestration/role-config";
import {
	type ArmId,
	type CapabilityClass,
	type Outcome,
	RouterBandit,
	type WinRateRow,
	defaultBanditStorePath,
} from "../providers/router-bandit";

/** A candidate model the pipeline says is reachable right now. */
export interface ModelCandidate {
	provider: string;
	model: string;
}

/**
 * Map a pipeline stage/role to the capability class the bandit keeps stats
 * along. The pipeline's roles collapse onto three axes:
 *
 *   - `orchestrator` / `context`  -> `writing`  (planning + compaction, prose)
 *   - `engineer` / `repair-*`     -> `code`     (writing runnable code)
 *   - `qa`                        -> `judge`    (reviewing an artifact)
 *
 * Unknown stage labels default to `code`, the pipeline's dominant work.
 */
export function stageCapabilityClass(stage: string): CapabilityClass {
	const s = stage.toLowerCase();
	if (s === "orchestrator" || s === "context") return "writing";
	if (s === "qa") return "judge";
	if (s === "engineer" || s.startsWith("repair")) return "code";
	return "code";
}

/**
 * Derive a reward in [0, 1] from a stage's real outcome. This is the learning
 * signal, and it comes only from what the pipeline actually recorded - never a
 * seeded or invented number:
 *
 *   - a clean pass (ok, no obstacles)      -> 1.0
 *   - a pass that hit obstacles on the way -> 0.7 (it worked, but not first-try)
 *   - a stage the pipeline marked failed   -> 0.2 (some credit, it still ran)
 */
export function qualityFromStage(rec: Pick<StageRecord, "ok" | "obstacles">): number {
	if (!rec.ok) return 0.2;
	return rec.obstacles.length === 0 ? 1.0 : 0.7;
}

/**
 * Learned per-task-class model chooser for the MoA pipeline. Thin adapter over
 * a persisted `RouterBandit`: it owns the stage->class mapping and the reward
 * derivation, and exposes exactly the two seams the pipeline needs.
 */
export class MoaRouter {
	private readonly bandit: RouterBandit;
	private readonly storePath: string;

	constructor(opts: { bandit?: RouterBandit; storePath?: string; rng?: () => number } = {}) {
		this.storePath = opts.storePath ?? defaultBanditStorePath();
		this.bandit = opts.bandit ?? new RouterBandit({ rng: opts.rng });
	}

	/**
	 * Load a router from disk (or start empty when there is no stats file yet).
	 * A corrupt file relearns rather than throwing - a bad stats file must never
	 * brick a build.
	 */
	static load(storePath: string = defaultBanditStorePath(), rng?: () => number): MoaRouter {
		const bandit = RouterBandit.load(storePath, rng);
		return new MoaRouter({ bandit, storePath });
	}

	/** Persist the learned stats back to disk. */
	save(): void {
		this.bandit.save(this.storePath);
	}

	/**
	 * Selector the pipeline consults before running a stage. Given the role and
	 * the live candidate roster, pick the arm the bandit favours for that role's
	 * capability class. Returns `undefined` (not a guess) when there are no
	 * candidates, so the pipeline falls back to its configured default.
	 *
	 * An arrow property (bound `this`) so it can be handed to the pipeline as a
	 * plain function, and generic so it returns the caller's own element type -
	 * the pipeline passes rich `Model` objects and gets a `Model` back, not a
	 * stripped candidate.
	 */
	chooseModel = <T extends ModelCandidate>(role: RoleName, candidates: T[]): T | undefined => {
		if (candidates.length === 0) return undefined;
		const cls = stageCapabilityClass(role);
		const arms: ArmId[] = candidates.map((c) => ({ provider: c.provider, model: c.model }));
		const picked = this.bandit.select(cls, arms);
		if (!picked) return undefined;
		return candidates.find((c) => c.provider === picked.provider && c.model === picked.model);
	};

	/**
	 * Fold the pipeline's per-stage ledger back into the bandit as reward. Each
	 * record is credited to (its capability class, its provider:model arm) with a
	 * quality derived from the real outcome plus the measured latency.
	 */
	recordStages(stages: StageRecord[], now: number = Date.now()): void {
		for (const rec of stages) {
			const cls = stageCapabilityClass(rec.stage);
			const outcome: Outcome = {
				quality: qualityFromStage(rec),
				latencyMs: rec.ms > 0 ? rec.ms : undefined,
			};
			this.bandit.record(cls, { provider: rec.provider, model: rec.model }, outcome, now);
		}
	}

	/** Observed win-rate rows for a class - real recorded evidence, for reporting. */
	winRates(cls: CapabilityClass): WinRateRow[] {
		return this.bandit.winRates(cls);
	}
}
