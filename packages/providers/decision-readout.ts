/**
 * Decision readout judge (issue #3455). Flag-off trial, EIGHT_DECISION_JUDGE=1.
 *
 * Instead of asking a model to write prose and parsing a verdict out of it
 * (SeleneJudge + parseVerdict), this asks a user-run llama.cpp server one
 * typed yes/no question on its /v1/systemone endpoint and reads back the
 * probability that the answer is yes. Nothing is generated.
 *
 * Wire shape, from llama.cpp PR 29818 (merge a4cb4c61, tools/server/README.md
 * "POST /v1/systemone" and tools/server/server-decision.cpp):
 *   request:  { state, questions: { <id>: { type: "noul", instructions, criteria?: { true, false } } } }
 *   response: { model, answers: { <id>: { type: "noul", noul: <P(true) in 0..1> } }, usage }
 *   errors:   400 invalid request, 501 not a decision model.
 *
 * Fail-closed doctrine, same as local-judge.ts: unreachable, timeout, HTTP
 * error, oversized or malformed body, a probability that is not a finite
 * number in [0, 1], or a probability below the threshold are all FAIL.
 * The endpoint must be loopback; anything else is refused before a request.
 */

import type { JudgeVerdict } from "./local-judge";

export const DECISION_QUESTION_ID = "pass";
export const DEFAULT_DECISION_BASE_URL = "http://127.0.0.1:8080";
export const DEFAULT_DECISION_THRESHOLD = 0.9;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

export interface DecisionReadoutConfig {
	/** llama-server base URL. Must be loopback. */
	baseUrl?: string;
	/** P(yes) must be at least this to pass. Clamped to (0, 1]. */
	threshold?: number;
	/** Whole-request deadline, body read included. */
	timeoutMs?: number;
	/** Response bodies larger than this are a fail. */
	maxResponseBytes?: number;
}

/** True when the flag is on. Anything other than exactly "1" is off. */
export function decisionJudgeEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env.EIGHT_DECISION_JUDGE === "1";
}

/** Config from env: EIGHT_DECISION_JUDGE_URL, EIGHT_DECISION_JUDGE_THRESHOLD. */
export function decisionConfigFromEnv(
	env: Record<string, string | undefined> = process.env,
): DecisionReadoutConfig {
	const t = Number(env.EIGHT_DECISION_JUDGE_THRESHOLD);
	return {
		baseUrl: env.EIGHT_DECISION_JUDGE_URL || undefined,
		threshold: env.EIGHT_DECISION_JUDGE_THRESHOLD ? t : undefined,
	};
}

/** Loopback check: 127.0.0.0/8, localhost, ::1. http or https, no credentials. */
export function isLoopbackUrl(url: string): boolean {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return false;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return false;
	if (u.username || u.password) return false;
	const h = u.hostname.toLowerCase();
	if (h === "localhost" || h === "[::1]" || h === "::1") return true;
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Request body for one yes/no question. Pure. Output and rubric clamped like buildJudgePrompt. */
export function buildDecisionRequest(output: string, rubric: string): Record<string, unknown> {
	return {
		state: ["## RUBRIC", rubric.trim().slice(0, 2000), "", "## OUTPUT", output.slice(0, 6000)].join(
			"\n",
		),
		questions: {
			[DECISION_QUESTION_ID]: {
				type: "noul",
				instructions:
					"Does the OUTPUT fully satisfy every item of the RUBRIC? Partial satisfaction is no.",
				criteria: {
					true: "the output satisfies every rubric item",
					false: "the output misses or only partly meets at least one rubric item",
				},
			},
		},
	};
}

/**
 * Read P(yes) out of a /v1/systemone response. Pure. Returns null for any
 * shape that is not answers.<id>.noul as a finite number in [0, 1].
 */
export function parseDecisionProbability(raw: string): number | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	const answer = (parsed as { answers?: Record<string, unknown> } | null)?.answers?.[
		DECISION_QUESTION_ID
	] as { type?: unknown; noul?: unknown } | undefined;
	if (!answer || answer.type !== "noul") return null;
	const p = answer.noul;
	if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) return null;
	return p;
}

/** Pass iff p >= threshold. Null (no usable answer) is always a fail. */
export function decideVerdict(p: number | null, threshold: number, raw: string): JudgeVerdict {
	if (p === null) {
		return failClosed("Decision readout returned no usable probability.", raw);
	}
	const pass = p >= threshold;
	return {
		pass,
		rationale: `P(pass)=${p.toFixed(4)} ${pass ? ">=" : "<"} threshold ${threshold}.`,
		raw,
		source: "decision-readout",
		probability: p,
	};
}

export class DecisionReadoutJudge {
	private readonly baseUrl: string;
	private readonly threshold: number;
	private readonly timeoutMs: number;
	private readonly maxResponseBytes: number;

	constructor(config: DecisionReadoutConfig = {}) {
		this.baseUrl = (config.baseUrl ?? DEFAULT_DECISION_BASE_URL).replace(/\/$/, "");
		const t = config.threshold;
		// A threshold of 0 or below would pass everything; a non-number is a config error. Use the default.
		this.threshold =
			typeof t === "number" && Number.isFinite(t) && t > 0 && t <= 1
				? t
				: DEFAULT_DECISION_THRESHOLD;
		this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
	}

	/** Judge one output against a rubric. Never throws; fails closed to FAIL. */
	async judge(output: string, rubric: string): Promise<JudgeVerdict> {
		if (!isLoopbackUrl(this.baseUrl)) {
			return failClosed(`Decision judge refused: ${this.baseUrl} is not a loopback URL.`, "");
		}
		let raw: string;
		try {
			const res = await fetch(`${this.baseUrl}/v1/systemone`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(buildDecisionRequest(output, rubric)),
				signal: AbortSignal.timeout(this.timeoutMs),
				redirect: "error",
			});
			if (!res.ok) {
				return failClosed(`Decision judge endpoint error: ${res.status} ${res.statusText}`, "");
			}
			const body = await readCapped(res, this.maxResponseBytes);
			if (body === null) {
				return failClosed(`Decision judge response exceeded ${this.maxResponseBytes} bytes.`, "");
			}
			raw = body;
		} catch (err) {
			return failClosed(
				`Decision judge unreachable: ${err instanceof Error ? err.message : String(err)}`,
				"",
			);
		}
		return decideVerdict(parseDecisionProbability(raw), this.threshold, raw.slice(0, 2000));
	}

	/**
	 * True when the loopback llama-server answers GET /health with 2xx.
	 * 503 (model loading), a non-loopback URL, or any error is unavailable.
	 */
	async isAvailable(): Promise<boolean> {
		if (!isLoopbackUrl(this.baseUrl)) return false;
		try {
			const res = await fetch(`${this.baseUrl}/health`, {
				signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5000)),
				redirect: "error",
			});
			await res.body?.cancel();
			return res.ok;
		} catch {
			return false;
		}
	}
}

/** Read a body up to `max` bytes. Returns null when it is larger. */
async function readCapped(res: Response, max: number): Promise<string | null> {
	const declared = Number(res.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > max) {
		await res.body?.cancel();
		return null;
	}
	if (!res.body) return "";
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

function failClosed(reason: string, raw: string): JudgeVerdict {
	return { pass: false, rationale: reason, raw, source: "fail-closed" };
}
