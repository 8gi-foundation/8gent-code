/**
 * HTTP client for a local `laya-serve` exposing POST /v1/systemone.
 *
 * The request is passed through unchanged. The response is mapped
 * defensively: probabilities are validated and renormalised here, and
 * `chosen` / `confidence` are recomputed from them, so a server that
 * drifts from the contract cannot hand the harness an unnormalised or
 * self-inconsistent answer.
 */

import {
	type Answer,
	type DecideBackend,
	DecideError,
	DecideUnavailableError,
	type FetchLike,
	type Question,
	type SystemOneRequest,
	type SystemOneResponse,
	answerFromDistribution,
	renormalise,
	validateRequest,
} from "../types";

export const DEFAULT_LAYA_URL = "http://127.0.0.1:8000";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface LayaBackendOptions {
	/** Defaults to env LAYA_URL, then http://127.0.0.1:8000. */
	url?: string;
	/** Model label reported before the server tells us its own. */
	model?: string;
	timeoutMs?: number;
	fetch?: FetchLike;
	env?: Record<string, string | undefined>;
}

export function resolveLayaUrl(env: Record<string, string | undefined> = process.env): string {
	return (env.LAYA_URL?.trim() || DEFAULT_LAYA_URL).replace(/\/+$/, "");
}

/** Slot distribution for a question from whatever shape the server sent. */
export function mapProbabilities(question: Question, raw: unknown): number[] {
	if (question.kind === "noul") {
		let yes: number | undefined;
		if (typeof raw === "number") yes = raw;
		else if (Array.isArray(raw) && raw.length === 2) return renormalise(raw.map(Number));
		else if (raw && typeof raw === "object") {
			const r = raw as Record<string, unknown>;
			if (typeof r.yes === "number") yes = r.yes;
			else if (typeof r.no === "number") yes = 1 - r.no;
		}
		if (yes === undefined || !Number.isFinite(yes) || yes < 0 || yes > 1) {
			throw new DecideError(`laya: noul answer "${question.id}" has no usable yes probability`);
		}
		return [yes, 1 - yes];
	}
	const slots = question.kind === "choice" ? question.options : question.levels;
	if (Array.isArray(raw)) {
		if (raw.length !== slots.length) {
			throw new DecideError(`laya: answer "${question.id}" has ${raw.length} probabilities for ${slots.length} slots`);
		}
		return renormalise(raw.map(Number));
	}
	if (raw && typeof raw === "object") {
		// Keyed by option / level text.
		const r = raw as Record<string, unknown>;
		return renormalise(slots.map((s) => (typeof r[s] === "number" ? (r[s] as number) : 0)));
	}
	throw new DecideError(`laya: answer "${question.id}" has no probabilities`);
}

export class LayaBackend implements DecideBackend {
	readonly name = "laya";
	model: string;
	private readonly url: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: FetchLike;

	constructor(opts: LayaBackendOptions = {}) {
		this.url = (opts.url ?? resolveLayaUrl(opts.env)).replace(/\/+$/, "");
		this.model = opts.model ?? "laya";
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
	}

	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		validateRequest(request);
		const started = performance.now();
		let res: Response;
		try {
			res = await this.fetchImpl(`${this.url}/v1/systemone`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(request),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (err) {
			throw new DecideUnavailableError(`laya unreachable at ${this.url}: ${(err as Error).message}`);
		}
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new DecideError(`laya /v1/systemone ${res.status}: ${body.slice(0, 200)}`);
		}
		const json = (await res.json()) as Record<string, unknown>;
		const rawAnswers = Array.isArray(json.answers) ? (json.answers as Array<Record<string, unknown>>) : null;
		if (!rawAnswers) throw new DecideError("laya: response has no answers array");
		const byId = new Map(rawAnswers.filter((a) => a && typeof a.id === "string").map((a) => [a.id as string, a]));
		const answers: Answer[] = request.questions.map((q) => {
			const raw = byId.get(q.id);
			if (!raw) throw new DecideError(`laya: no answer for question "${q.id}"`);
			return answerFromDistribution(q, mapProbabilities(q, raw.probabilities));
		});
		if (typeof json.model === "string" && json.model) this.model = json.model;
		return {
			answers,
			backend: this.name,
			model: this.model,
			latencyMs: Math.round(performance.now() - started),
		};
	}
}
