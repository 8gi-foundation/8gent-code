/**
 * Local-first turn scoring for the kernel build-verify loop
 * (issue #2750, Step 3).
 *
 * `ProductionLoop.processTurn` used to send every scored turn to the cloud
 * judge (Gemini Flash via OpenRouter, `judge.ts`). This module puts the
 * local verdict API (`packages/eight/verdict.ts`: Selene-1-Mini over
 * Ollama / LM Studio) in front of it:
 *
 *   - `LocalTurnScorer`  - scores one agent turn per criterion with the
 *     local judge. Nothing leaves the device.
 *   - `LocalFirstScorer` - prefers the local scorer; the legacy cloud judge
 *     is only a fallback and disappears in Step 5.
 *
 * Fail-closed doctrine (the MiniCPM lesson): a criterion the local judge
 * explicitly could not verify counts 0, never 1. But a turn where the judge
 * produced NO real verdict at all is "not scored" (`LocalJudgeUnavailableError`)
 * rather than a fabricated all-zero record, so a down judge never poisons
 * the training buffer with fake failures.
 */

import { LocalVerdict } from "../eight/verdict";
import type { JudgeVerdict } from "../eight/verdict";
import { redact } from "../memory/redact";
import { LruCache } from "../tools/lru-cache";
import { parallelMap } from "../tools/parallel-map";
import { DEFAULT_CRITERIA_WEIGHTS, type ScoringCriteria } from "./judge";
import {
	DEFAULT_HISTORY_PATH,
	type ScoreRecord,
	appendScoreRecord,
	scoreTrend,
} from "./score-history";

/** The scorer contract the production loop depends on. */
export interface TurnScorer {
	score(
		sessionId: string,
		turnIndex: number,
		model: string,
		prompt: string,
		response: string,
	): Promise<ScoreRecord>;
	isAvailable(): Promise<boolean>;
	getScoreTrend(days?: number): Array<{ date: string; avg: number; count: number }>;
}

/** Thrown when no judge could produce a real verdict. Callers skip scoring. */
export class LocalJudgeUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LocalJudgeUnavailableError";
	}
}

export type CriterionName = keyof ScoringCriteria;

/** Stable criterion order, so records and tests are deterministic. */
export const CRITERIA_ORDER: readonly CriterionName[] = [
	"executionSuccess",
	"codeQuality",
	"toolEfficiency",
	"directness",
];

/**
 * One falsifiable statement per criterion. The local judge answers PASS or
 * FAIL against each; the same four axes the cloud judge scored 0-1.
 */
const CRITERION_STATEMENTS: Record<CriterionName, string> = {
	executionSuccess:
		"The response actually solves the user's task, and any code in it is valid and would execute correctly.",
	codeQuality: "Any code in the response is clean, idiomatic, and well-structured.",
	toolEfficiency:
		"The response works the task efficiently, without wasted, redundant, or unnecessary steps.",
	directness:
		"The response is focused and direct: it solves the task without over-engineering or unrequested extras.",
};

/**
 * Build the rubric handed to the local judge for one criterion. Pure and
 * deterministic; the task text is clamped so the judge prompt stays bounded
 * (the judge itself clamps rubrics at 2000 chars).
 */
export function buildCriterionRubric(criterion: CriterionName, prompt: string): string {
	const task = prompt.trim().slice(0, 1500);
	return [
		`PASS only if: ${CRITERION_STATEMENTS[criterion]}`,
		"",
		"The user's task was:",
		task,
	].join("\n");
}

/** The subset of the local verdict API this scorer uses (tests inject fakes). */
export interface VerdictJudge {
	judge(output: string, rubric: string): Promise<JudgeVerdict>;
	isAvailable(): Promise<{ selene: boolean }>;
}

export interface LocalTurnScorerConfig {
	/** Local verdict backend. Defaults to `new LocalVerdict()`; tests inject. */
	verdict?: VerdictJudge;
	/** Score history file. Shared with the cloud judge so trends stay one series. */
	historyPath?: string;
	/** Criteria weights. Same defaults as the cloud judge. */
	criteria?: ScoringCriteria;
	/**
	 * Concurrent judge calls per turn. Default 2: the judge is one local
	 * model; flooding it with all four criteria at once just queues and
	 * risks timeouts.
	 */
	concurrency?: number;
	/** How long an availability probe result is trusted, in ms. */
	availabilityTtlMs?: number;
}

const DEFAULT_AVAILABILITY_TTL_MS = 30_000;

/**
 * Scores one agent turn entirely on-device: each criterion becomes a
 * PASS/FAIL verdict from the local judge (pass = 1, fail = 0), combined
 * with the same weights the cloud judge used, written to the same history.
 */
export class LocalTurnScorer implements TurnScorer {
	private readonly verdict: VerdictJudge;
	private readonly historyPath: string;
	private readonly criteria: ScoringCriteria;
	private readonly concurrency: number;
	private readonly availabilityTtlMs: number;
	private readonly availability = new LruCache<string, boolean>({ maxEntries: 1 });

	constructor(config: LocalTurnScorerConfig = {}) {
		this.verdict = config.verdict ?? new LocalVerdict();
		this.historyPath = config.historyPath ?? DEFAULT_HISTORY_PATH;
		this.criteria = config.criteria ?? DEFAULT_CRITERIA_WEIGHTS;
		this.concurrency = config.concurrency ?? 2;
		this.availabilityTtlMs = config.availabilityTtlMs ?? DEFAULT_AVAILABILITY_TTL_MS;
	}

	/**
	 * Score one turn with the local judge.
	 *
	 * The judge sees the RAW response (nothing leaves the device, so there is
	 * no egress to gate), but the persisted record is redacted: score history
	 * feeds the training buffer, and secrets must never be baked into either.
	 *
	 * Throws `LocalJudgeUnavailableError` when every criterion came back
	 * fail-closed, i.e. the judge never produced a single real verdict.
	 */
	async score(
		sessionId: string,
		turnIndex: number,
		model: string,
		prompt: string,
		response: string,
	): Promise<ScoreRecord> {
		const verdicts = await parallelMap(
			CRITERIA_ORDER,
			(criterion) => this.verdict.judge(response, buildCriterionRubric(criterion, prompt)),
			this.concurrency,
		);

		if (verdicts.every((v) => v.source === "fail-closed")) {
			throw new LocalJudgeUnavailableError(
				`local judge produced no real verdict for any criterion: ${verdicts[0]?.rationale ?? "no rationale"}`,
			);
		}

		const scores = {
			executionSuccess: 0,
			codeQuality: 0,
			toolEfficiency: 0,
			directness: 0,
		};
		CRITERIA_ORDER.forEach((criterion, i) => {
			// Fail-closed verdicts on individual criteria count 0: silence is
			// never approval.
			scores[criterion] = verdicts[i].pass ? 1 : 0;
		});

		const overall =
			scores.executionSuccess * this.criteria.executionSuccess +
			scores.codeQuality * this.criteria.codeQuality +
			scores.toolEfficiency * this.criteria.toolEfficiency +
			scores.directness * this.criteria.directness;

		const record: ScoreRecord = {
			sessionId,
			turnIndex,
			model,
			prompt: redact(prompt).slice(0, 500),
			response: redact(response).slice(0, 500),
			scores: { ...scores, overall: Math.round(overall * 100) / 100 },
			timestamp: new Date().toISOString(),
			judgeSource: "local",
		};

		appendScoreRecord(this.historyPath, record);
		return record;
	}

	/** True when the local judge endpoint is reachable. Probe result is cached briefly. */
	async isAvailable(): Promise<boolean> {
		const cached = this.availability.get("selene");
		if (cached !== undefined) return cached;
		const available = (await this.verdict.isAvailable()).selene;
		this.availability.set("selene", available, this.availabilityTtlMs);
		return available;
	}

	getScoreTrend(days = 7): Array<{ date: string; avg: number; count: number }> {
		return scoreTrend(this.historyPath, days);
	}
}

export interface LocalFirstScorerConfig {
	/** The local scorer. Always preferred. */
	local: TurnScorer;
	/**
	 * Legacy cloud judge fallback (issue #2750 Step 5 removes it). When
	 * omitted, there is no cloud path at all.
	 */
	cloud?: TurnScorer;
	/** Allow falling back to the cloud judge when the local judge is down. Default true until Step 5. */
	allowCloudFallback?: boolean;
}

/**
 * The scorer the production loop uses: local judge first, legacy cloud
 * judge only when the local judge is unreachable and fallback is allowed.
 * Fails closed (throws) when neither can score, so the loop skips the turn
 * instead of recording a fabricated score.
 */
export class LocalFirstScorer implements TurnScorer {
	private readonly local: TurnScorer;
	private readonly cloud?: TurnScorer;
	private readonly allowCloudFallback: boolean;

	constructor(config: LocalFirstScorerConfig) {
		this.local = config.local;
		this.cloud = config.cloud;
		this.allowCloudFallback = config.allowCloudFallback ?? true;
	}

	async score(
		sessionId: string,
		turnIndex: number,
		model: string,
		prompt: string,
		response: string,
	): Promise<ScoreRecord> {
		if (await this.local.isAvailable()) {
			try {
				return await this.local.score(sessionId, turnIndex, model, prompt, response);
			} catch (err) {
				// Only an "I could not judge at all" outcome falls through to the
				// fallback; real scoring errors propagate.
				if (!(err instanceof LocalJudgeUnavailableError)) throw err;
			}
		}
		if (this.cloud && this.allowCloudFallback) {
			return this.cloud.score(sessionId, turnIndex, model, prompt, response);
		}
		throw new LocalJudgeUnavailableError(
			this.allowCloudFallback
				? "no judge available: local judge down and no cloud fallback configured"
				: "no judge available: local judge down and cloud fallback disabled",
		);
	}

	async isAvailable(): Promise<boolean> {
		if (await this.local.isAvailable()) return true;
		if (this.cloud && this.allowCloudFallback) return this.cloud.isAvailable();
		return false;
	}

	getScoreTrend(days = 7): Array<{ date: string; avg: number; count: number }> {
		// Both backends write the same history file; the local scorer's view is
		// the whole series.
		return this.local.getScoreTrend(days);
	}
}
