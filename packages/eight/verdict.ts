/**
 * Local verdict API (issue #2750, Step 2).
 *
 * The kernel-facing facade over the local judge layer in
 * `packages/providers/local-judge.ts`. One object exposes both verdict paths
 * the kernel needs, entirely on-device:
 *
 *   - judge(output, rubric) -> pass/fail + rationale, via Selene-1-Mini.
 *   - score(candidates)     -> candidates ranked by scalar reward, via
 *                              Skywork-Reward-V2.
 *
 * This is the seam the cloud judge (`packages/kernel/judge.ts`, Gemini Flash
 * over OpenRouter) is being retired behind. It adds no transport of its own:
 * it delegates to the fail-closed judges in the providers layer, so the
 * doctrine (local-first, fail closed, no cloud call, no PII egress) holds by
 * construction - there is no code path in this module that can reach the
 * network on its own.
 */

import {
	type CandidateScore,
	type JudgeVerdict,
	type ScoreCandidate,
	type SeleneConfig,
	SeleneJudge,
	type SkyworkConfig,
	SkyworkScorer,
} from "../providers/local-judge";

export type {
	CandidateScore,
	JudgeVerdict,
	ScoreCandidate,
} from "../providers/local-judge";

export interface LocalVerdictConfig {
	/** Selene (generative pass/fail judge) config. */
	selene?: SeleneConfig;
	/** Skywork (scalar reward scorer) config. */
	skywork?: SkyworkConfig;
}

/** Reachability of each underlying local judge. */
export interface VerdictAvailability {
	selene: boolean;
	skywork: boolean;
}

/**
 * The local verdict API. Holds one Selene judge and one Skywork scorer and
 * routes the two kernel verdict operations to them. Neither method throws;
 * both fail closed to a safe default (a FAIL verdict, or `null` scores that
 * rank last).
 */
export class LocalVerdict {
	private readonly selene: SeleneJudge;
	private readonly skywork: SkyworkScorer;

	constructor(config: LocalVerdictConfig = {}) {
		this.selene = new SeleneJudge(config.selene);
		this.skywork = new SkyworkScorer(config.skywork);
	}

	/**
	 * Judge one output against a rubric. Pass/fail + rationale from Selene.
	 * Fails closed to FAIL when the judge is unreachable or unclear.
	 */
	judge(output: string, rubric: string): Promise<JudgeVerdict> {
		return this.selene.judge(output, rubric);
	}

	/**
	 * Rank candidate outputs by scalar reward (Skywork), highest first.
	 * Candidates the reward model could not score rank last.
	 */
	score(candidates: ScoreCandidate[]): Promise<CandidateScore[]> {
		return this.skywork.score(candidates);
	}

	/**
	 * The best candidate by reward, or `null` when there are no candidates or
	 * none could be scored. The winner must carry a real (non-null) score, so
	 * a silent reward model yields no winner rather than a false one.
	 */
	async best(candidates: ScoreCandidate[]): Promise<CandidateScore | null> {
		const ranked = await this.score(candidates);
		const top = ranked[0];
		return top && top.score !== null ? top : null;
	}

	/** Reachability of both local judges, checked in parallel. */
	async isAvailable(): Promise<VerdictAvailability> {
		const [selene, skywork] = await Promise.all([
			this.selene.isAvailable(),
			this.skywork.isAvailable(),
		]);
		return { selene, skywork };
	}
}
