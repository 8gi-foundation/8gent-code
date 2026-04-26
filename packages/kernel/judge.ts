/**
 * Phase 2: Judge Scoring Integration
 *
 * Wires a PRM (Process Reward Model) to score agent responses.
 * Uses Gemini Flash via OpenRouter as the judge — free and fast enough
 * for async scoring. Tracks score distributions over time.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

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

interface ScoringCriteria {
	/** Did the code execute correctly? (0-1) */
	executionSuccess: number;
	/** Is the code clean and idiomatic? (0-1) */
	codeQuality: number;
	/** Were tools used efficiently? (0-1) */
	toolEfficiency: number;
	/** Was the solution direct (not over-engineered)? (0-1) */
	directness: number;
}

export interface ScoreRecord {
	sessionId: string;
	turnIndex: number;
	model: string;
	prompt: string;
	response: string;
	scores: {
		executionSuccess: number;
		codeQuality: number;
		toolEfficiency: number;
		directness: number;
		overall: number;
	};
	timestamp: string;
}

interface ScoreHistory {
	records: ScoreRecord[];
	stats: {
		totalScored: number;
		avgOverall: number;
		scoresByModel: Record<string, { avg: number; count: number }>;
	};
	updatedAt: string;
}

const DEFAULT_JUDGE_CONFIG: JudgeConfig = {
	prmUrl: "https://openrouter.ai/api/v1",
	prmModel: "google/gemini-2.5-flash:free",
	prmApiKey: "",
	historyPath: ".8gent/kernel/score-history.json",
	criteria: {
		executionSuccess: 0.4,
		codeQuality: 0.2,
		toolEfficiency: 0.2,
		directness: 0.2,
	},
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
		const judgePrompt = `## User Prompt\n${prompt.slice(0, 2000)}\n\n## Agent Response\n${response.slice(0, 4000)}\n\nScore this response:`;

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
			prompt: prompt.slice(0, 500),
			response: response.slice(0, 500),
			scores: { ...scores, overall: Math.round(overall * 100) / 100 },
			timestamp: new Date().toISOString(),
		};

		this.appendRecord(record);
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
				this.score(
					item.sessionId,
					item.turnIndex,
					item.model,
					item.prompt,
					item.response,
				),
			),
		);
		return results
			.filter(
				(r): r is PromiseFulfilledResult<ScoreRecord> =>
					r.status === "fulfilled",
			)
			.map((r) => r.value);
	}

	/**
	 * Get score distribution statistics.
	 */
	getDistribution(): ScoreHistory["stats"] {
		const history = this.loadHistory();
		return history.stats;
	}

	/**
	 * Get recent scores for a specific model.
	 */
	getModelScores(model: string, limit = 20): ScoreRecord[] {
		const history = this.loadHistory();
		return history.records.filter((r) => r.model === model).slice(-limit);
	}

	/**
	 * Get the average score trend (last N records, grouped by day).
	 */
	getScoreTrend(days = 7): Array<{ date: string; avg: number; count: number }> {
		const history = this.loadHistory();
		const grouped: Record<string, { total: number; count: number }> = {};

		for (const record of history.records) {
			const date = record.timestamp.split("T")[0];
			if (!grouped[date]) grouped[date] = { total: 0, count: 0 };
			grouped[date].total += record.scores.overall;
			grouped[date].count += 1;
		}

		return Object.entries(grouped)
			.map(([date, { total, count }]) => ({
				date,
				avg: Math.round((total / count) * 100) / 100,
				count,
			}))
			.slice(-days);
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

	private async callJudge(
		prompt: string,
	): Promise<{
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
			throw new Error(
				`Judge model error: ${response.status} ${response.statusText}`,
			);
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

	private loadHistory(): ScoreHistory {
		try {
			if (existsSync(this.config.historyPath)) {
				return JSON.parse(readFileSync(this.config.historyPath, "utf-8"));
			}
		} catch {}
		return {
			records: [],
			stats: { totalScored: 0, avgOverall: 0, scoresByModel: {} },
			updatedAt: "",
		};
	}

	private appendRecord(record: ScoreRecord): void {
		const history = this.loadHistory();
		history.records.push(record);

		// Keep last 500 records
		if (history.records.length > 500) {
			history.records = history.records.slice(-500);
		}

		// Update stats
		history.stats.totalScored += 1;
		const allOverall = history.records.map((r) => r.scores.overall);
		history.stats.avgOverall =
			Math.round(
				(allOverall.reduce((a, b) => a + b, 0) / allOverall.length) * 100,
			) / 100;

		// Per-model stats
		const byModel: Record<string, number[]> = {};
		for (const r of history.records) {
			if (!byModel[r.model]) byModel[r.model] = [];
			byModel[r.model].push(r.scores.overall);
		}
		history.stats.scoresByModel = {};
		for (const [model, scores] of Object.entries(byModel)) {
			history.stats.scoresByModel[model] = {
				avg:
					Math.round(
						(scores.reduce((a, b) => a + b, 0) / scores.length) * 100,
					) / 100,
				count: scores.length,
			};
		}

		history.updatedAt = new Date().toISOString();

		const dir = dirname(this.config.historyPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(this.config.historyPath, JSON.stringify(history, null, 2));
	}
}

function clamp(v: number): number {
	return Math.max(0, Math.min(1, v));
}
