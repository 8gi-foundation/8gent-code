/**
 * Jev backend: TypeSafe AI's hosted decision model, through the Vercel AI
 * Gateway. HOSTED, OPT-IN, SIDE WORK ONLY.
 *
 * Off unless env EIGHT_DECIDE_BACKEND=jev (see index.ts), and then only
 * with AI_GATEWAY_API_KEY in env. The state of every question leaves the
 * machine, so this backend never takes part in a SIGI scored run or in
 * anything labelled local: `jevForbidden` refuses it under SIGI_RUN or
 * PILOT_RUN, or while the pilot lock exists. The decider wraps it in
 * `FallbackBackend`: on any error or timeout the local judge answers, and
 * every decision is logged with the backend that made it.
 *
 * Wire shape (checked against the gateway's own validator on 2026-10-07;
 * TypeSafe's primitives docs for the answer fields):
 *
 *   POST https://ai-gateway.vercel.sh/v1/evaluate
 *   { model: "typesafe-ai/jev", state, questions: { <id>: { type, instructions, criteria } } }
 *     type "boolean"  (our noul)   criteria omitted
 *     type "choice"                criteria { <optionKey>: <option text> }
 *     type "score"                 criteria [ <level text>, ... ] low to high
 *   -> { model, answers: { <id>: { type, probabilities: {...}, choice?, score?, confidence?, probability? | noul? } } }
 *
 * Probabilities are renormalised here and `chosen` / `confidence` are
 * recomputed from them (as the laya backend does), so the gateway cannot
 * hand the harness a self-inconsistent answer. Code owns thresholds.
 *
 * Nothing from the gateway's error body reaches a log or an error message
 * except the HTTP status and its fixed `error.type` code: the body can
 * carry the request state, and free text is not something to log.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type Answer,
	type ChoiceQuestion,
	type DecideBackend,
	DecideError,
	DecideUnavailableError,
	type FetchLike,
	type Question,
	type ScoreQuestion,
	type SystemOneRequest,
	type SystemOneResponse,
	answerFromDistribution,
	renormalise,
	validateRequest,
} from "../types";

export const JEV_URL = "https://ai-gateway.vercel.sh/v1/evaluate";
export const JEV_MODEL = "typesafe-ai/jev";
/** The only env var the key is read from. Never a file, never an argument. */
export const JEV_KEY_ENV = "AI_GATEWAY_API_KEY";
/** Hosted round trip is 70 to 500 ms when it works; past this the local judge answers. */
export const JEV_DEFAULT_TIMEOUT_MS = 5_000;
/** The pilot's lock, relative to HOME. While it exists a scored or pilot run owns this machine. */
export const PILOT_LOCK_RELATIVE = ".8gent/rishi-pilot/pilot.lock";

export interface JevBackendOptions {
	/** Required. From env AI_GATEWAY_API_KEY via `resolveJevKey`. */
	apiKey: string;
	/** Defaults to JEV_URL. Tests point it at a fake; production never changes it. */
	url?: string;
	timeoutMs?: number;
	fetch?: FetchLike;
}

export function resolveJevKey(
	env: Record<string, string | undefined> = process.env,
): string | null {
	const k = env[JEV_KEY_ENV]?.trim();
	return k ? k : null;
}

/**
 * Why the hosted judge must not run right now, or null. A SIGI or pilot run
 * (env SIGI_RUN / PILOT_RUN set to anything non-empty) and the pilot lock
 * both mean a hosted call could land in a scored result. `exists` is
 * injectable for tests; HOME comes from env so a test can point it at a
 * temp dir.
 */
export function jevForbidden(
	env: Record<string, string | undefined> = process.env,
	exists: (p: string) => boolean = existsSync,
): string | null {
	for (const v of ["SIGI_RUN", "PILOT_RUN"])
		if (env[v]?.trim()) return `${v} is set: hosted judge not allowed in a scored or pilot run`;
	const lock = join(env.HOME?.trim() || homedir(), PILOT_LOCK_RELATIVE);
	if (exists(lock))
		return `pilot lock present at ${lock}: hosted judge not allowed while a pilot run owns this machine`;
	return null;
}

/**
 * Criteria keys for a choice question. Jev keys its answer by these, so they
 * must be unique and stable. Option text is used verbatim when every option
 * is distinct (it carries meaning for the model); otherwise the index is
 * appended to the duplicates.
 */
export function choiceKeys(options: string[]): string[] {
	return options.map((o, i) => (options.indexOf(o) === options.lastIndexOf(o) ? o : `${o} (${i})`));
}

type JevQuestion =
	| { type: "boolean"; instructions: string }
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "score"; instructions: string; criteria: string[] };

/** Our SystemOneRequest as the gateway's /v1/evaluate body. */
export function toJevBody(request: SystemOneRequest): {
	model: string;
	state: string;
	questions: Record<string, JevQuestion>;
	providerOptions: { gateway: { zeroDataRetention: boolean } };
} {
	const questions: Record<string, JevQuestion> = {};
	for (const q of request.questions) {
		if (q.kind === "noul") questions[q.id] = { type: "boolean", instructions: q.prompt };
		else if (q.kind === "choice") {
			const keys = choiceKeys(q.options);
			const criteria: Record<string, string> = {};
			q.options.forEach((o, i) => {
				criteria[keys[i]] = o;
			});
			questions[q.id] = { type: "choice", instructions: q.prompt, criteria };
		} else questions[q.id] = { type: "score", instructions: q.prompt, criteria: [...q.levels] };
	}
	return {
		model: JEV_MODEL,
		state: request.state,
		questions,
		providerOptions: { gateway: { zeroDataRetention: true } },
	};
}

const num = (x: unknown): number | undefined =>
	typeof x === "number" && Number.isFinite(x) ? x : undefined;

/** Slot distribution for `question` from one Jev answer object. */
export function fromJevAnswer(question: Question, raw: unknown): number[] {
	if (!raw || typeof raw !== "object")
		throw new DecideError(`jev: answer "${question.id}" is not an object`);
	const a = raw as Record<string, unknown>;
	const probs =
		a.probabilities && typeof a.probabilities === "object"
			? (a.probabilities as Record<string, unknown>)
			: null;
	if (question.kind === "noul") {
		// The gateway documents `probability`; TypeSafe's native API says `noul`. Accept either, then the map.
		const no = num(probs?.false);
		const yes =
			num(a.probability) ??
			num(a.noul) ??
			num(a.boolean) ??
			num(probs?.true) ??
			(no === undefined ? undefined : 1 - no);
		if (yes === undefined || yes < 0 || yes > 1)
			throw new DecideError(`jev: noul answer "${question.id}" has no usable probability`);
		return [yes, 1 - yes];
	}
	if (question.kind === "choice") {
		const keys = choiceKeys((question as ChoiceQuestion).options);
		if (probs) return renormalise(keys.map((k) => num(probs[k]) ?? 0));
		if (typeof a.choice === "string" && keys.includes(a.choice))
			return keys.map((k) => (k === a.choice ? 1 : 0));
		throw new DecideError(`jev: choice answer "${question.id}" has no probabilities`);
	}
	const levels = (question as ScoreQuestion).levels;
	if (probs) return renormalise(levels.map((_, i) => num(probs[String(i)]) ?? 0));
	throw new DecideError(`jev: score answer "${question.id}" has no probabilities`);
}

/** The gateway's fixed error code (`error.type`, e.g. no_providers_available), or "unknown". Never its free text. */
function errorCode(text: string): string {
	try {
		const t = (JSON.parse(text) as { error?: { type?: unknown } })?.error?.type;
		return typeof t === "string" && /^[a-z0-9_]{1,64}$/i.test(t) ? t : "unknown";
	} catch {
		return "unknown";
	}
}

export class JevBackend implements DecideBackend {
	readonly name = "jev";
	model = JEV_MODEL;
	private readonly url: string;
	private readonly apiKey: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: FetchLike;

	constructor(opts: JevBackendOptions) {
		if (!opts.apiKey) throw new DecideUnavailableError(`jev: no ${JEV_KEY_ENV} in env`);
		this.apiKey = opts.apiKey;
		this.url = opts.url ?? JEV_URL;
		this.timeoutMs = opts.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
		this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
	}

	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		validateRequest(request);
		const started = performance.now();
		let res: Response;
		try {
			res = await this.fetchImpl(this.url, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
				body: JSON.stringify(toJevBody(request)),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (err) {
			// A fetch error message can quote the URL, never the body or the key; the error name is enough.
			throw new DecideUnavailableError(`jev unreachable: ${(err as Error)?.name ?? "error"}`);
		}
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new DecideUnavailableError(`jev /v1/evaluate ${res.status} ${errorCode(text)}`);
		}
		const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
		const rawAnswers =
			json?.answers && typeof json.answers === "object"
				? (json.answers as Record<string, unknown>)
				: null;
		if (!rawAnswers) throw new DecideError("jev: response has no answers object");
		const answers: Answer[] = request.questions.map((q) => {
			if (!(q.id in rawAnswers)) throw new DecideError(`jev: no answer for question "${q.id}"`);
			return answerFromDistribution(q, fromJevAnswer(q, rawAnswers[q.id]));
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

/**
 * Primary backend with a lazily built fallback. Any error from the primary
 * (timeout, refused, 4xx, 5xx, unreadable answer) sends the same request
 * to the fallback, built once on first need. A primary that hangs past
 * `timeoutMs` without failing is treated the same way. Every decision is
 * reported through `log` with the backend that made it, so a hosted judge
 * that is silently failing over cannot pass for one that is working.
 */
export interface FallbackLog {
	backend: string;
	model: string;
	latencyMs: number;
	/** Set when the primary failed: its name and why. */
	fellBackFrom?: { backend: string; reason: string };
}

export class FallbackBackend implements DecideBackend {
	private secondary: Promise<DecideBackend> | null = null;
	private readonly timeoutMs: number;

	constructor(
		private readonly primary: DecideBackend,
		private readonly buildSecondary: () => Promise<DecideBackend>,
		private readonly log: (entry: FallbackLog) => void,
		timeoutMs = JEV_DEFAULT_TIMEOUT_MS,
	) {
		this.timeoutMs = timeoutMs;
	}

	get name(): string {
		return this.primary.name;
	}

	get model(): string {
		return this.primary.model;
	}

	private withTimeout(p: Promise<SystemOneResponse>): Promise<SystemOneResponse> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() =>
					reject(
						new DecideUnavailableError(`${this.primary.name} timed out after ${this.timeoutMs} ms`),
					),
				this.timeoutMs,
			);
		});
		return Promise.race([p, late]).finally(() => clearTimeout(timer));
	}

	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		try {
			const res = await this.withTimeout(this.primary.ask(request));
			this.log({ backend: res.backend, model: res.model, latencyMs: res.latencyMs });
			return res;
		} catch (err) {
			const reason = (err as Error)?.message ?? String(err);
			if (!this.secondary) {
				const p = this.buildSecondary();
				this.secondary = p;
				p.catch(() => {
					if (this.secondary === p) this.secondary = null;
				});
			}
			const local = await this.secondary;
			const res = await local.ask(request);
			this.log({
				backend: res.backend,
				model: res.model,
				latencyMs: res.latencyMs,
				fellBackFrom: { backend: this.primary.name, reason },
			});
			return res;
		}
	}
}

/** One stderr line per decision; the default `log` when EIGHT_DECIDE_BACKEND=jev is set. */
export function logDecisionToStderr(entry: FallbackLog): void {
	const tail = entry.fellBackFrom
		? ` fallback_from=${entry.fellBackFrom.backend} reason=${JSON.stringify(entry.fellBackFrom.reason)}`
		: "";
	process.stderr.write(
		`[decide] backend=${entry.backend} model=${entry.model} latency_ms=${entry.latencyMs}${tail}\n`,
	);
}
