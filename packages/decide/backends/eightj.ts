/**
 * 8J backend: Artale's System One decision model (HF 8GI/8j), served on this machine by
 * packages/decide/serve-8j/serve_8j.py and spoken to over its model card's contract.
 *
 *   POST {url}/v1/systemone
 *   { state, questions: { <id>: { type: "noul" | "choice" | "score", instructions, criteria? } } }
 *   -> { model, answers: { <id>: { noul: pYes } | { probabilities: {<key>: p} } | { probabilities: [p, ...] } } }
 *   GET {url}/health -> { ok: true, model }
 *
 * Selected by env EIGHT_8J_URL (the probe puts it ahead of every other judge, because naming it
 * is an explicit choice), or by createDecider({ backend: "8j" }). The URL must be a loopback
 * address: the state is a command that has not run yet and never leaves the machine.
 *
 * FAIL CLOSED: a timeout, refused connection, non-200, or an answer without a usable probability
 * throws DecideUnavailableError / DecideError. bashGuard turns that into "block", and the System
 * One gate, when 8J is the selected judge (`eightJSelected`), sends the command to a person
 * instead of falling back to rules-only: never an allow.
 *
 * Code owns thresholds: the server returns probabilities only. The fitted lines live in
 * calibration/8j-<model>.json, keyed by the model name the server reports.
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
import { choiceKeys } from "./jev";

export const EIGHTJ_BACKEND_NAME = "8j";
/** The env var that selects 8J and says where its server is. */
export const EIGHTJ_URL_ENV = "EIGHT_8J_URL";
/** Per-question budget override, in ms. */
export const EIGHTJ_TIMEOUT_ENV = "EIGHT_8J_TIMEOUT_MS";
/** 244 ms median on a laptop CPU; a phone is slower. Past this the verdict is never an allow. */
export const EIGHTJ_DEFAULT_TIMEOUT_MS = 5_000;

/** True when env selects 8J as the judge (EIGHT_8J_URL set). The gate then fails closed to a person. */
export function eightJSelected(env: Record<string, string | undefined> = process.env): boolean {
	return !!env[EIGHTJ_URL_ENV]?.trim();
}

/** True for http(s) URLs on 127.0.0.0/8, ::1 or localhost. */
export function isLoopbackUrl(url: string): boolean {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return false;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return false;
	const host = u.hostname.toLowerCase();
	return host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** The server root from env, trailing slashes removed; throws when unset or not loopback. */
export function resolveEightJUrl(env: Record<string, string | undefined> = process.env): string {
	const raw = env[EIGHTJ_URL_ENV]?.trim();
	if (!raw) throw new DecideUnavailableError(`8j: ${EIGHTJ_URL_ENV} is not set`);
	const url = raw.replace(/\/+$/, "");
	if (!isLoopbackUrl(url))
		throw new DecideUnavailableError(
			`8j: ${EIGHTJ_URL_ENV} must be a loopback http URL on this machine`,
		);
	return url;
}

export function resolveEightJTimeout(
	env: Record<string, string | undefined> = process.env,
): number {
	const n = Number((env[EIGHTJ_TIMEOUT_ENV] ?? "").trim());
	return Number.isFinite(n) && n > 0 ? n : EIGHTJ_DEFAULT_TIMEOUT_MS;
}

/** GET /health. Returns the model the server reports, or throws DecideUnavailableError. */
export async function eightJHealth(
	fetchImpl: FetchLike,
	url: string,
	timeoutMs: number,
): Promise<string> {
	let res: Response;
	try {
		res = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
	} catch (err) {
		throw new DecideUnavailableError(
			`8j unreachable at ${url}: ${(err as Error)?.name ?? "error"}`,
		);
	}
	if (!res.ok) throw new DecideUnavailableError(`8j health ${res.status} at ${url}`);
	const json = (await res.json().catch(() => null)) as { ok?: unknown; model?: unknown } | null;
	if (json?.ok !== true || typeof json.model !== "string" || !json.model)
		throw new DecideUnavailableError(`8j health at ${url} names no model`);
	return json.model;
}

type CardQuestion =
	| { type: "noul"; instructions: string }
	| { type: "choice"; instructions: string; criteria: Record<string, null> }
	| { type: "score"; instructions: string; criteria: string[] };

/** Our SystemOneRequest as the model card's body. Choice options become keys with no description. */
export function toCardBody(request: SystemOneRequest): {
	state: string;
	questions: Record<string, CardQuestion>;
} {
	const questions: Record<string, CardQuestion> = {};
	for (const q of request.questions) {
		if (q.kind === "noul") questions[q.id] = { type: "noul", instructions: q.prompt };
		else if (q.kind === "choice")
			questions[q.id] = {
				type: "choice",
				instructions: q.prompt,
				criteria: Object.fromEntries(choiceKeys(q.options).map((k) => [k, null])),
			};
		else questions[q.id] = { type: "score", instructions: q.prompt, criteria: [...q.levels] };
	}
	return { state: request.state, questions };
}

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Slot distribution for `question` from one card answer. Throws on anything unusable. */
export function fromCardAnswer(question: Question, raw: unknown): number[] {
	const a = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
	if (!a) throw new DecideError(`8j: answer "${question.id}" is not an object`);
	if (question.kind === "noul") {
		const yes = a.noul;
		if (!finite(yes) || yes < 0 || yes > 1)
			throw new DecideError(`8j: noul answer "${question.id}" has no usable probability`);
		return [yes, 1 - yes];
	}
	const probs = a.probabilities;
	if (question.kind === "choice") {
		if (!probs || typeof probs !== "object" || Array.isArray(probs))
			throw new DecideError(`8j: choice answer "${question.id}" has no probabilities`);
		const p = probs as Record<string, unknown>;
		return renormalise(choiceKeys(question.options).map((k) => (finite(p[k]) ? p[k] : 0)));
	}
	if (!Array.isArray(probs) || probs.length !== question.levels.length)
		throw new DecideError(`8j: score answer "${question.id}" has no probability per level`);
	return renormalise(probs.map((p) => (finite(p) ? p : Number.NaN)));
}

export interface EightJBackendOptions {
	/** Server root on a loopback address. Defaults to env EIGHT_8J_URL. */
	url?: string;
	/** Model the server reported at /health; replaced by the model each answer names. */
	model: string;
	timeoutMs?: number;
	fetch?: FetchLike;
	env?: Record<string, string | undefined>;
}

export class EightJBackend implements DecideBackend {
	readonly name = EIGHTJ_BACKEND_NAME;
	model: string;
	private readonly url: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: FetchLike;

	/** The loopback server the state goes to. */
	get endpoint(): string {
		return this.url;
	}

	constructor(opts: EightJBackendOptions) {
		const env = opts.env ?? process.env;
		const url = (opts.url ?? resolveEightJUrl(env)).replace(/\/+$/, "");
		if (!isLoopbackUrl(url))
			throw new DecideUnavailableError(
				"8j: the server must be on a loopback address on this machine",
			);
		this.url = url;
		this.model = opts.model;
		this.timeoutMs = opts.timeoutMs ?? resolveEightJTimeout(env);
		this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
	}

	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		validateRequest(request);
		const started = performance.now();
		let json: Record<string, unknown> | null;
		try {
			const res = await this.fetchImpl(`${this.url}/v1/systemone`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(toCardBody(request)),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
			if (!res.ok) throw new DecideUnavailableError(`8j /v1/systemone ${res.status}`);
			json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
		} catch (err) {
			if (err instanceof DecideUnavailableError) throw err;
			// A timeout and a refused connection read the same to the caller: no verdict, fail closed.
			throw new DecideUnavailableError(
				`8j unreachable at ${this.url}: ${(err as Error)?.name ?? "error"}`,
			);
		}
		const raw =
			json?.answers && typeof json.answers === "object"
				? (json.answers as Record<string, unknown>)
				: null;
		if (!raw) throw new DecideError("8j: response has no answers object");
		const answers: Answer[] = request.questions.map((q) => {
			if (!(q.id in raw)) throw new DecideError(`8j: no answer for question "${q.id}"`);
			return answerFromDistribution(q, fromCardAnswer(q, raw[q.id]));
		});
		if (typeof json?.model === "string" && json.model) this.model = json.model;
		return {
			answers,
			backend: this.name,
			model: this.model,
			latencyMs: Math.round(performance.now() - started),
		};
	}
}
