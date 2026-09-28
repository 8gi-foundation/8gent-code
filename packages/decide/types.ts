/**
 * System One wire contract.
 *
 * The harness asks typed questions about a `state` string and gets
 * calibrated probabilities back. Code, not the model, owns thresholds:
 * a backend only ever reports probability mass, never a decision.
 *
 * Shape mirrors the `/v1/systemone` endpoint so a local `laya-serve`
 * and the in-process Ollama backend are interchangeable.
 */

/** Question kinds. */
export type QuestionKind = "noul" | "choice" | "score";

/** Max options a `choice` question may carry on the wire. */
export const MAX_CHOICE_OPTIONS = 255;
/** Inclusive bounds on the number of levels in a `score` question. */
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;

export interface NoulQuestion {
	id: string;
	kind: "noul";
	prompt: string;
}

export interface ChoiceQuestion {
	id: string;
	kind: "choice";
	prompt: string;
	/** 2..255 option strings. */
	options: string[];
}

export interface ScoreQuestion {
	id: string;
	kind: "score";
	prompt: string;
	/** 2..10 levels, each a description of what that level means. Ordered low to high. */
	levels: string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface SystemOneRequest {
	state: string;
	questions: Question[];
}

export interface NoulAnswer {
	id: string;
	kind: "noul";
	probabilities: { yes: number };
	/** max(pYes, 1 - pYes). */
	confidence: number;
}

export interface ChoiceAnswer {
	id: string;
	kind: "choice";
	/** One probability per option, same order, sums to 1. */
	probabilities: number[];
	/** Index into `options` of the most probable option. */
	chosen: number;
	/** Probability of `chosen`. */
	confidence: number;
}

export interface ScoreAnswer {
	id: string;
	kind: "score";
	/** One probability per level, same order, sums to 1. */
	probabilities: number[];
	/** Index into `levels` of the most probable level. */
	chosen: number;
	/** Probability of `chosen`. */
	confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneResponse {
	answers: Answer[];
	backend: string;
	model: string;
	latencyMs: number;
}

/** A backend turns a request into calibrated answers. It never applies thresholds. */
export interface DecideBackend {
	readonly name: string;
	readonly model: string;
	ask(request: SystemOneRequest): Promise<SystemOneResponse>;
}

/** Minimal fetch signature so tests can inject a fake. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class DecideError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DecideError";
	}
}

export class DecideUnavailableError extends DecideError {
	constructor(message: string) {
		super(message);
		this.name = "DecideUnavailableError";
	}
}

/** Structural validation of a request. Throws DecideError on the first problem. */
export function validateRequest(request: SystemOneRequest): void {
	if (!request || typeof request !== "object") throw new DecideError("request must be an object");
	if (typeof request.state !== "string") throw new DecideError("request.state must be a string");
	if (!Array.isArray(request.questions) || request.questions.length === 0) {
		throw new DecideError("request.questions must be a non-empty array");
	}
	const seen = new Set<string>();
	for (const q of request.questions) {
		if (!q || typeof q.id !== "string" || q.id.length === 0) throw new DecideError("question.id must be a non-empty string");
		if (seen.has(q.id)) throw new DecideError(`duplicate question id "${q.id}"`);
		seen.add(q.id);
		if (typeof q.prompt !== "string" || q.prompt.length === 0) {
			throw new DecideError(`question "${q.id}": prompt must be a non-empty string`);
		}
		if (q.kind === "noul") continue;
		if (q.kind === "choice") {
			if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > MAX_CHOICE_OPTIONS) {
				throw new DecideError(`question "${q.id}": choice needs 2..${MAX_CHOICE_OPTIONS} options`);
			}
			continue;
		}
		if (q.kind === "score") {
			if (!Array.isArray(q.levels) || q.levels.length < MIN_SCORE_LEVELS || q.levels.length > MAX_SCORE_LEVELS) {
				throw new DecideError(`question "${q.id}": score needs ${MIN_SCORE_LEVELS}..${MAX_SCORE_LEVELS} levels`);
			}
			continue;
		}
		throw new DecideError(`question "${(q as { id: string }).id}": unknown kind "${String((q as { kind: unknown }).kind)}"`);
	}
}

/**
 * Renormalise non-negative masses to a distribution. Throws if there is no
 * mass at all: a backend that saw none of the answer tokens has no signal,
 * and silently returning a uniform distribution would hide that.
 */
export function renormalise(masses: number[]): number[] {
	let total = 0;
	for (const m of masses) {
		if (!Number.isFinite(m) || m < 0) throw new DecideError(`invalid probability mass ${m}`);
		total += m;
	}
	if (total <= 0) throw new DecideError("no probability mass on any answer token");
	return masses.map((m) => m / total);
}

/** Index of the largest value; ties resolve to the lowest index (deterministic). */
export function argmax(values: number[]): number {
	let best = 0;
	for (let i = 1; i < values.length; i++) {
		if (values[i] > values[best]) best = i;
	}
	return best;
}

/** Build a typed answer from a distribution over the question's answer slots. */
export function answerFromDistribution(question: Question, dist: number[]): Answer {
	if (question.kind === "noul") {
		const yes = dist[0];
		return { id: question.id, kind: "noul", probabilities: { yes }, confidence: Math.max(yes, 1 - yes) };
	}
	const chosen = argmax(dist);
	return { id: question.id, kind: question.kind, probabilities: dist, chosen, confidence: dist[chosen] };
}
