/**
 * Phase 2: Judge Scoring Integration (LEGACY CLOUD PATH)
 *
 * Wires a PRM (Process Reward Model) to score agent responses.
 * Uses Gemini Flash via OpenRouter as the judge — free and fast enough
 * for async scoring. Tracks score distributions over time.
 *
 * Issue #2750: this cloud verdict path is being retired behind the local
 * judge layer (`local-scorer.ts` over `packages/eight/verdict.ts`). The
 * production loop now scores local-first and only falls back here; Step 5
 * removes this module once the local judges win the gauntlet.
 */

import { redact } from "../memory/redact";
import { containsSecret } from "../permissions/goal-secret-scrub";
import { anonymize, containsPii } from "../permissions/pii-anonymizer";
import {
	DEFAULT_HISTORY_PATH,
	type ScoreHistory,
	type ScoreRecord,
	appendScoreRecord,
	loadScoreHistory,
	scoreTrend,
} from "./score-history";

export type { ScoreRecord } from "./score-history";

export interface JudgeConfig {
	/** Judge model endpoint (default: OpenRouter) */
	prmUrl: string;
	/** Judge model ID */
	prmModel: string;
	/** API key for judge model */
	prmApiKey: string;
	/** Score history file path */
	historyPath: string;
	/** Scoring criteria weights */
	criteria: ScoringCriteria;
}

export interface ScoringCriteria {
	/** Did the code execute correctly? (0-1) */
	executionSuccess: number;
	/** Is the code clean and idiomatic? (0-1) */
	codeQuality: number;
	/** Were tools used efficiently? (0-1) */
	toolEfficiency: number;
	/** Was the solution direct (not over-engineered)? (0-1) */
	directness: number;
}

/** Default criteria weights, shared with the local scorer. */
export const DEFAULT_CRITERIA_WEIGHTS: ScoringCriteria = {
	executionSuccess: 0.4,
	codeQuality: 0.2,
	toolEfficiency: 0.2,
	directness: 0.2,
};

const DEFAULT_JUDGE_CONFIG: JudgeConfig = {
	prmUrl: "https://openrouter.ai/api/v1",
	prmModel: "google/gemini-2.5-flash:free",
	prmApiKey: "",
	historyPath: DEFAULT_HISTORY_PATH,
	criteria: DEFAULT_CRITERIA_WEIGHTS,
};

const JUDGE_SYSTEM_PROMPT = `You are a code quality judge for an autonomous coding agent. Score the agent's response on these criteria. Return ONLY a JSON object with numeric scores (0.0 to 1.0):

{
  "executionSuccess": <0-1, would this code run correctly?>,
  "codeQuality": <0-1, is the code clean, idiomatic, well-structured?>,
  "toolEfficiency": <0-1, did the agent use appropriate tools without waste?>,
  "directness": <0-1, was the solution focused and not over-engineered?>
}

Be strict but fair. A score of 0.7 means "good", 0.9 means "excellent", 0.5 means "mediocre".`;

export class JudgeScorer {
	private config: JudgeConfig;

	constructor(config: Partial<JudgeConfig> = {}) {
		this.config = { ...DEFAULT_JUDGE_CONFIG, ...config };
		if (!this.config.prmApiKey) {
			this.config.prmApiKey = process.env.OPENROUTER_API_KEY ?? "";
		}
	}

	/**
	 * Score an agent response using the judge model.
	 */
	async score(
		sessionId: string,
		turnIndex: number,
		model: string,
		prompt: string,
		response: string,
	): Promise<ScoreRecord> {
		// Privacy gate: the judge runs in the cloud (OpenRouter), so nothing raw
		// from the user's work may leave the device. Two layers, in order:
		//   1. Redact known secret patterns (keys/tokens/credentials).
		//   2. Anonymize PII (emails, phones, names, addresses, card/IBAN/SSN).
		// If anything secret-shaped OR PII-shaped still survives after both
		// passes, skip cloud scoring entirely and record a neutral, scrubbed
		// row rather than leak.
		const redactedPrompt = redact(prompt);
		const redactedResponse = redact(response);
		const safePrompt = anonymize(redactedPrompt).text;
		const safeResponse = anonymize(redactedResponse).text;
		if (
			containsSecret(safePrompt) ||
			containsSecret(safeResponse) ||
			containsPii(safePrompt) ||
			containsPii(safeResponse)
		) {
			const skipped: ScoreRecord = {
				sessionId,
				turnIndex,
				model,
				prompt: "[redacted: secret or PII detected, not scored]",
				response: "[redacted: secret or PII detected, not scored]",
				scores: {
					executionSuccess: 0,
					codeQuality: 0,
					toolEfficiency: 0,
					directness: 0,
					overall: 0,
				},
				timestamp: new Date().toISOString(),
				judgeSource: "cloud",
			};
			appendScoreRecord(this.config.historyPath, skipped);
			return skipped;
		}

		const judgePrompt = `## User Prompt\n${safePrompt.slice(0, 2000)}\n\n## Agent Response\n${safeResponse.slice(0, 4000)}\n\nScore this response:`;

		const scores = await this.callJudge(judgePrompt);
		const weights = this.config.criteria;
		const overall =
			scores.executionSuccess * weights.executionSuccess +
			scores.codeQuality * weights.codeQuality +
			scores.toolEfficiency * weights.toolEfficiency +
			scores.directness * weights.directness;

		const record: ScoreRecord = {
			sessionId,
			turnIndex,
			model,
			prompt: safePrompt.slice(0, 500),
			response: safeResponse.slice(0, 500),
			scores: { ...scores, overall: Math.round(overall * 100) / 100 },
			timestamp: new Date().toISOString(),
			judgeSource: "cloud",
		};

		appendScoreRecord(this.config.historyPath, record);
		return record;
	}

	/**
	 * Score a batch of responses (fire-and-forget for async training).
	 */
	async scoreBatch(
		items: Array<{
			sessionId: string;
			turnIndex: number;
			model: string;
			prompt: string;
			response: string;
		}>,
	): Promise<ScoreRecord[]> {
		const results = await Promise.allSettled(
			items.map((item) =>
				this.score(item.sessionId, item.turnIndex, item.model, item.prompt, item.response),
			),
		);
		return results
			.filter((r): r is PromiseFulfilledResult<ScoreRecord> => r.status === "fulfilled")
			.map((r) => r.value);
	}

	/**
	 * Get score distribution statistics.
	 */
	getDistribution(): ScoreHistory["stats"] {
		return loadScoreHistory(this.config.historyPath).stats;
	}

	/**
	 * Get recent scores for a specific model.
	 */
	getModelScores(model: string, limit = 20): ScoreRecord[] {
		const history = loadScoreHistory(this.config.historyPath);
		return history.records.filter((r) => r.model === model).slice(-limit);
	}

	/**
	 * Get the average score trend (last N records, grouped by day).
	 */
	getScoreTrend(days = 7): Array<{ date: string; avg: number; count: number }> {
		return scoreTrend(this.config.historyPath, days);
	}

	/**
	 * Check if judge model is reachable.
	 */
	async isAvailable(): Promise<boolean> {
		try {
			const res = await fetch(`${this.config.prmUrl}/models`, {
				headers: { Authorization: `Bearer ${this.config.prmApiKey}` },
				signal: AbortSignal.timeout(5000),
			});
			return res.ok;
		} catch {
			return false;
		}
	}

	// ── Private helpers ────────────────────────────────────────────────

	private async callJudge(prompt: string): Promise<{
		executionSuccess: number;
		codeQuality: number;
		toolEfficiency: number;
		directness: number;
	}> {
		const response = await fetch(`${this.config.prmUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.config.prmApiKey}`,
				"HTTP-Referer": "https://8gent.app",
				"X-Title": "8gent Kernel Judge",
			},
			body: JSON.stringify({
				model: this.config.prmModel,
				messages: [
					{ role: "system", content: JUDGE_SYSTEM_PROMPT },
					{ role: "user", content: prompt },
				],
				temperature: 0.1,
				max_tokens: 200,
			}),
		});

		if (!response.ok) {
			throw new Error(`Judge model error: ${response.status} ${response.statusText}`);
		}

		const data = await response.json();
		const content = data.choices?.[0]?.message?.content ?? "{}";

		// Extract JSON from response (may be wrapped in markdown fences)
		const jsonMatch = content.match(/\{[\s\S]*\}/);
		if (!jsonMatch) {
			throw new Error("Judge returned no parseable JSON");
		}

		const parsed = JSON.parse(jsonMatch[0]);
		return {
			executionSuccess: clamp(parsed.executionSuccess ?? 0.5),
			codeQuality: clamp(parsed.codeQuality ?? 0.5),
			toolEfficiency: clamp(parsed.toolEfficiency ?? 0.5),
			directness: clamp(parsed.directness ?? 0.5),
		};
	}
}

function clamp(v: number): number {
	return Math.max(0, Math.min(1, v));
}
