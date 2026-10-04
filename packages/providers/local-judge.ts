/**
 * Local judge layer for the kernel (issue #2750, first slice).
 *
 * Replaces the cloud verdict path (Gemini Flash via OpenRouter in
 * packages/kernel/judge.ts) with local-first judges that never leave the
 * device:
 *
 *   - Selene-1-Mini (Atla, generative) over Ollama / LM Studio, for the
 *     pass/fail + rationale verdict on a single output against a rubric.
 *   - Skywork-Reward-V2 (scalar reward model) over a vLLM-style endpoint,
 *     for ranking candidate outputs by a numeric score.
 *
 * This module owns two responsibilities:
 *
 *   1. Deterministic, network-free parsing of a judge model's raw output
 *      into a typed verdict / score. These pure functions are the contract
 *      the rest of the kernel builds on, and they are the part that is unit
 *      tested here.
 *   2. Thin transport to the local model (Ollama /api/generate for Selene,
 *      an OpenAI-compatible pooling/score endpoint for Skywork).
 *
 * Fail-closed doctrine (the MiniCPM lesson): a judge that cannot produce a
 * confident verdict returns FAIL, never PASS. MiniCPM was pulled as a judge
 * because it false-approved 29-43% of the time. A judge whose output does
 * not clearly say PASS is treated as a fail, and an unreachable judge is a
 * fail too. Silence is never approval.
 */

import { createOllamaServer } from "../local-model-server";
import {
	DecisionReadoutJudge,
	decisionConfigFromEnv,
	decisionJudgeEnabled,
} from "./decision-readout";

/** Where a verdict came from, so callers can tell a real judgment from a fail-closed default. */
export type VerdictSource = "selene" | "decision-readout" | "fail-closed";

/** The result of judging one output against a rubric. */
export interface JudgeVerdict {
	/** True only when the judge explicitly returned a passing verdict. */
	pass: boolean;
	/** Human-readable reason. On fail-closed, explains why no verdict was reached. */
	rationale: string;
	/** The raw judge output (empty string when the judge was never reached). */
	raw: string;
	/** How this verdict was produced. "fail-closed" means no real judgment happened. */
	source: VerdictSource;
}

/** A single candidate to be scored by the scalar reward model. */
export interface ScoreCandidate {
	/** Stable identifier so callers can map scores back to candidates. */
	id: string;
	/** The candidate text to score. */
	output: string;
}

/** A scored candidate, highest reward is best. */
export interface CandidateScore {
	id: string;
	/** Scalar reward. `null` when the endpoint returned nothing parseable. */
	score: number | null;
}

export interface SeleneConfig {
	/** Ollama base URL. Defaults to the standard local Ollama port. */
	baseUrl?: string;
	/** Selene model tag as installed in Ollama / LM Studio. */
	model?: string;
	/** Per-request timeout in milliseconds. */
	timeoutMs?: number;
}

export interface SkyworkConfig {
	/** vLLM (OpenAI-compatible) base URL for the reward model. */
	baseUrl?: string;
	/** Skywork-Reward-V2 model tag as served by vLLM. */
	model?: string;
	/** Per-request timeout in milliseconds. */
	timeoutMs?: number;
}

const DEFAULT_SELENE_BASE_URL = "http://localhost:11434";
const DEFAULT_SELENE_MODEL = "selene-mini";
const DEFAULT_SKYWORK_BASE_URL = "http://localhost:8000";
const DEFAULT_SKYWORK_MODEL = "skywork-reward-v2";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Build the prompt handed to Selene. Pure and deterministic so the exact
 * text a judge sees is testable and stable across runs.
 *
 * Output and rubric are clamped to keep the judge prompt bounded; a judge
 * that is fed an unbounded blob is a judge that times out.
 */
export function buildJudgePrompt(output: string, rubric: string): string {
	const safeRubric = rubric.trim().slice(0, 2000);
	const safeOutput = output.slice(0, 6000);
	return [
		"You are a strict evaluation judge. Assess whether the OUTPUT satisfies the RUBRIC.",
		"",
		"Be strict. If the output only partially satisfies the rubric, that is a FAIL.",
		"",
		"Respond in exactly this shape and nothing else:",
		"VERDICT: PASS or VERDICT: FAIL",
		"REASON: one sentence explaining the verdict.",
		"",
		"## RUBRIC",
		safeRubric,
		"",
		"## OUTPUT",
		safeOutput,
	].join("\n");
}

/**
 * Parse Selene's raw text into a typed verdict. Pure, deterministic,
 * network-free. This is the fail-closed chokepoint: any output that does
 * not carry an explicit PASS verdict is a FAIL.
 */
export function parseVerdict(raw: string): JudgeVerdict {
	const text = (raw ?? "").trim();
	if (text.length === 0) {
		return {
			pass: false,
			rationale: "Judge returned no output.",
			raw: "",
			source: "fail-closed",
		};
	}

	const verdictMatch = text.match(/VERDICT:\s*(PASS|FAIL)/i);
	const reasonMatch = text.match(/REASON:\s*(.+)/i);
	const rationale = reasonMatch?.[1]?.trim() || firstLine(text);

	if (!verdictMatch) {
		// No parseable verdict token. Do not guess PASS from prose - that is
		// exactly the false-approve failure mode that killed MiniCPM.
		return {
			pass: false,
			rationale: `No explicit verdict found; treating as fail. ${rationale}`.trim(),
			raw: text,
			source: "fail-closed",
		};
	}

	const pass = verdictMatch[1].toUpperCase() === "PASS";
	return {
		pass,
		rationale,
		raw: text,
		source: "selene",
	};
}

/**
 * Parse a scalar reward from a Skywork-style endpoint response. Pure and
 * deterministic. Accepts the common shapes a reward endpoint returns:
 *   - a bare number ("0.82")
 *   - `{ "score": 0.82 }`
 *   - `{ "reward": 0.82 }`
 *   - vLLM pooling: `{ "data": [{ "data": [0.82] }] }`
 * Returns `null` when nothing parseable is present, so callers can rank a
 * missing score last rather than treating it as zero-and-real.
 */
export function parseScore(raw: string): number | null {
	const text = (raw ?? "").trim();
	if (text.length === 0) return null;

	// Bare number first (cheapest, most common for a raw reward head).
	const bare = Number(text);
	if (Number.isFinite(bare)) return bare;

	try {
		const parsed = JSON.parse(text);
		const candidate =
			pickNumber(parsed?.score) ??
			pickNumber(parsed?.reward) ??
			pickNumber(parsed?.data?.[0]?.data?.[0]) ??
			pickNumber(parsed?.data?.[0]?.score);
		if (candidate !== null) return candidate;
	} catch {
		// Fall through to a loose numeric scan below.
	}

	// Last resort: first finite number embedded in the text.
	const numMatch = text.match(/-?\d+(?:\.\d+)?/);
	if (numMatch) {
		const n = Number(numMatch[0]);
		if (Number.isFinite(n)) return n;
	}
	return null;
}

/**
 * Rank scored candidates highest-first. Candidates with a `null` score
 * (endpoint gave nothing usable) sort last, deterministically by id, so a
 * silent reward model never wins a ranking.
 */
export function rankByScore(scores: CandidateScore[]): CandidateScore[] {
	return [...scores].sort((a, b) => {
		if (a.score === null && b.score === null) return a.id.localeCompare(b.id);
		if (a.score === null) return 1;
		if (b.score === null) return -1;
		if (b.score !== a.score) return b.score - a.score;
		return a.id.localeCompare(b.id);
	});
}

/**
 * Selene generative judge over local Ollama / LM Studio. Produces a
 * pass/fail verdict for one output against a rubric. Every failure path
 * (unreachable model, HTTP error, timeout, unparseable output) resolves to
 * a fail-closed FAIL verdict rather than throwing, so a broken judge can
 * never be mistaken for an approval.
 */
export class SeleneJudge {
	private baseUrl: string;
	private model: string;
	private timeoutMs: number;

	constructor(config: SeleneConfig = {}) {
		this.baseUrl = (config.baseUrl ?? DEFAULT_SELENE_BASE_URL).replace(/\/$/, "");
		this.model = config.model ?? DEFAULT_SELENE_MODEL;
		this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** Judge one output against a rubric. Never throws; fails closed to FAIL. */
	async judge(output: string, rubric: string): Promise<JudgeVerdict> {
		// Flag-off trial (#3455): EIGHT_DECISION_JUDGE=1 routes to the llama.cpp
		// /v1/systemone probability reader. Read per call; off means unchanged.
		if (decisionJudgeEnabled()) {
			return new DecisionReadoutJudge(decisionConfigFromEnv()).judge(output, rubric);
		}
		const prompt = buildJudgePrompt(output, rubric);
		let raw: string;
		try {
			const res = await fetch(`${this.baseUrl}/api/generate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: this.model,
					prompt,
					stream: false,
					options: { temperature: 0 },
				}),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
			if (!res.ok) {
				return failClosed(`Judge endpoint error: ${res.status} ${res.statusText}`);
			}
			const data = (await res.json()) as { response?: string };
			raw = data.response ?? "";
		} catch (err) {
			return failClosed(`Judge unreachable: ${err instanceof Error ? err.message : String(err)}`);
		}
		return parseVerdict(raw);
	}

	/** True when the local Ollama server is reachable. */
	async isAvailable(): Promise<boolean> {
		return createOllamaServer({ baseUrl: this.baseUrl }).isHealthy({ signal: AbortSignal.timeout(5000) });
	}
}

/**
 * Skywork-Reward-V2 scalar scorer over a local vLLM-style endpoint. Turns a
 * set of candidate outputs into scalar rewards and ranks them highest-first.
 * Every failure path (unreachable endpoint, HTTP error, timeout, unparseable
 * body) resolves to a `null` score for that candidate rather than throwing,
 * and `null`-scored candidates rank last. A silent or unreachable reward
 * model therefore can never crown a winner.
 */
export class SkyworkScorer {
	private baseUrl: string;
	private model: string;
	private timeoutMs: number;

	constructor(config: SkyworkConfig = {}) {
		this.baseUrl = (config.baseUrl ?? DEFAULT_SKYWORK_BASE_URL).replace(/\/$/, "");
		this.model = config.model ?? DEFAULT_SKYWORK_MODEL;
		this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** Score one output. Never throws; unreachable/error/unparseable -> null. */
	async scoreOne(output: string): Promise<number | null> {
		let raw: string;
		try {
			const res = await fetch(`${this.baseUrl}/pooling`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: this.model, input: output.slice(0, 6000) }),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
			if (!res.ok) return null;
			raw = await res.text();
		} catch {
			return null;
		}
		return parseScore(raw);
	}

	/**
	 * Score every candidate and return them ranked highest-first. Candidates
	 * the reward model could not score get a `null` score and sort last.
	 */
	async score(candidates: ScoreCandidate[]): Promise<CandidateScore[]> {
		const scored = await Promise.all(
			candidates.map(async (c) => ({ id: c.id, score: await this.scoreOne(c.output) })),
		);
		return rankByScore(scored);
	}

	/** True when the local reward endpoint is reachable. */
	async isAvailable(): Promise<boolean> {
		try {
			const res = await fetch(`${this.baseUrl}/health`, {
				signal: AbortSignal.timeout(5000),
			});
			return res.ok;
		} catch {
			return false;
		}
	}
}

// -- helpers ----------------------------------------------------------------

function failClosed(reason: string): JudgeVerdict {
	return { pass: false, rationale: reason, raw: "", source: "fail-closed" };
}

function firstLine(text: string): string {
	return text.split("\n")[0].trim();
}

function pickNumber(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}
