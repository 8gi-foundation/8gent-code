/**
 * Ollama backend via next-token logprobs.
 *
 * For each question we build a deterministic prompt that ends right where
 * the model must emit a single answer token ("yes"/"no", a letter, or a
 * digit), ask Ollama for exactly one token with the top 20 logprobs, and
 * sum probability mass over the spelling variants of each answer label
 * (" Yes", "yes", "YES", "(A", "A." ...). The masses are renormalised over
 * the answer labels only, so the result is a distribution over the
 * question's options and nothing else.
 *
 * Settings are pinned (temperature 0, seed 1, raw prompt) so the same
 * input gives the same output.
 */

import { DEFAULT_OLLAMA_BASE_URL, resolveOllamaBaseUrl } from "../../local-model-server/ollama-host";
import {
	type Answer,
	type ChoiceQuestion,
	type DecideBackend,
	DecideError,
	type FetchLike,
	type Question,
	type ScoreQuestion,
	type SystemOneRequest,
	type SystemOneResponse,
	answerFromDistribution,
	renormalise,
	validateRequest,
} from "../types";

export const DEFAULT_OLLAMA_HOST = DEFAULT_OLLAMA_BASE_URL;
/** Letters cap the choice kind on this backend. Two-letter labels are out of scope. */
export const OLLAMA_MAX_CHOICE_OPTIONS = 26;
const TOP_LOGPROBS = 20;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface OllamaBackendOptions {
	model: string;
	/** Defaults to env OLLAMA_BASE_URL, then OLLAMA_HOST, then http://localhost:11434. */
	host?: string;
	/** Per-question request timeout. */
	timeoutMs?: number;
	fetch?: FetchLike;
	env?: Record<string, string | undefined>;
}

export interface TopLogprob {
	token: string;
	logprob: number;
}

/**
 * Resolve the Ollama base URL from env: OLLAMA_BASE_URL, then OLLAMA_HOST, then
 * localhost. The same resolver as the rest of the harness (#3149): a bare host
 * with no port gets Ollama's :11434, where this used to leave it portless and
 * reach port 80.
 */
export function resolveOllamaHost(env: Record<string, string | undefined> = process.env): string {
	return resolveOllamaBaseUrl(env);
}

// ----- Prompt templates --------------------------------------------------------

/**
 * Per-model template rule: qwen3 family models are hybrid reasoning models.
 * Prefixing "/no_think" asks them to skip the thinking block so the very
 * next token is the answer.
 */
export function modelPrefix(model: string): string {
	return model.toLowerCase().includes("qwen3") ? "/no_think\n" : "";
}

function header(state: string, prompt: string): string {
	return [
		"You are a careful, literal judge. Read the state, then answer the question.",
		"",
		"State:",
		state,
		"",
		`Question: ${prompt}`,
	].join("\n");
}

export function letterLabels(count: number): string[] {
	if (count > OLLAMA_MAX_CHOICE_OPTIONS) {
		throw new DecideError(
			`ollama backend supports at most ${OLLAMA_MAX_CHOICE_OPTIONS} choice options (got ${count}); use the laya backend for more`,
		);
	}
	return Array.from({ length: count }, (_, i) => String.fromCharCode(65 + i));
}

/**
 * Score labels are single digit tokens: 1..N for up to 9 levels, 0..9 for
 * exactly 10 levels (so "10" never has to span two tokens).
 */
export function scoreLabels(count: number): string[] {
	if (count === 10) return Array.from({ length: 10 }, (_, i) => String(i));
	return Array.from({ length: count }, (_, i) => String(i + 1));
}

/** Answer labels in slot order. For noul, slot 0 is yes and slot 1 is no. */
export function labelsFor(question: Question): string[] {
	if (question.kind === "noul") return ["yes", "no"];
	if (question.kind === "choice") return letterLabels(question.options.length);
	return scoreLabels(question.levels.length);
}

export function buildPrompt(model: string, state: string, question: Question): string {
	const prefix = modelPrefix(model);
	if (question.kind === "noul") {
		return `${prefix}${header(state, question.prompt)}\nAnswer (yes or no):`;
	}
	if (question.kind === "choice") {
		return `${prefix}${header(state, question.prompt)}\n${optionLines((question as ChoiceQuestion).options, labelsFor(question))}\nAnswer with the letter:`;
	}
	const labels = labelsFor(question);
	return `${prefix}${header(state, question.prompt)}\n${optionLines((question as ScoreQuestion).levels, labels)}\nAnswer with the number (${labels[0]}-${labels[labels.length - 1]}):`;
}

function optionLines(items: string[], labels: string[]): string {
	return items.map((item, i) => `${labels[i]}. ${item}`).join("\n");
}

// ----- Token mass --------------------------------------------------------------

/** Strip whitespace and surrounding punctuation so " (A", "A." and "A)" all read as "A". */
export function normaliseToken(token: string): string {
	return token.trim().replace(/^[\s(\[{"'*`]+/, "").replace(/[\s)\]}"'*`.:,;!]+$/, "");
}

function tokenMatches(kind: Question["kind"], token: string, label: string): boolean {
	const t = normaliseToken(token);
	// yes/no: any case. Letters: uppercase only, so the article "a" is not read as option A.
	if (kind === "noul") return t.toLowerCase() === label;
	return t === label;
}

/**
 * Sum probability mass per label over the returned top logprobs and
 * renormalise over the labels. Throws when no label token appears at all.
 */
export function distributionFromLogprobs(kind: Question["kind"], labels: string[], top: TopLogprob[]): number[] {
	const masses = labels.map(() => 0);
	for (const entry of top) {
		if (!entry || typeof entry.token !== "string" || !Number.isFinite(entry.logprob)) continue;
		for (let i = 0; i < labels.length; i++) {
			if (tokenMatches(kind, entry.token, labels[i])) {
				masses[i] += Math.exp(entry.logprob);
				break;
			}
		}
	}
	return renormalise(masses);
}

/** True when any entry in `top` is a spelling of one of the labels. Shared with the llamacpp backend. */
export function hasLabelMass(kind: Question["kind"], labels: string[], top: TopLogprob[]): boolean {
	return top.some((e) => typeof e?.token === "string" && labels.some((l) => tokenMatches(kind, e.token, l)));
}

// ----- Backend -----------------------------------------------------------------

export class OllamaBackend implements DecideBackend {
	readonly name = "ollama";
	readonly model: string;
	private readonly host: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: FetchLike;

	constructor(opts: OllamaBackendOptions) {
		if (!opts.model) throw new DecideError("ollama backend needs a model");
		this.model = opts.model;
		this.host = (opts.host ?? resolveOllamaHost(opts.env)).replace(/\/+$/, "");
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
	}

	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		validateRequest(request);
		const started = performance.now();
		const answers: Answer[] = [];
		for (const question of request.questions) {
			answers.push(await this.answerOne(request.state, question));
		}
		return {
			answers,
			backend: this.name,
			model: this.model,
			latencyMs: Math.round(performance.now() - started),
		};
	}

	private async answerOne(state: string, question: Question): Promise<Answer> {
		const labels = labelsFor(question);
		const prompt = buildPrompt(this.model, state, question);
		const top = await this.topLogprobs(prompt);
		if (!hasLabelMass(question.kind, labels, top)) {
			// Some tokenizers (Llama 3 on digits) emit the leading space as its own
			// token. If the most likely token is pure whitespace, commit to it and
			// read the next token instead. One step only, still deterministic.
			const lead = top.reduce((a, b) => (b.logprob > a.logprob ? b : a), top[0])?.token;
			if (typeof lead === "string" && lead.length > 0 && lead.trim() === "") {
				const next = await this.topLogprobs(prompt + lead);
				return answerFromDistribution(question, distributionFromLogprobs(question.kind, labels, next));
			}
		}
		return answerFromDistribution(question, distributionFromLogprobs(question.kind, labels, top));
	}

	private async topLogprobs(prompt: string): Promise<TopLogprob[]> {
		const res = await this.fetchImpl(`${this.host}/api/generate`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: this.model,
				prompt,
				stream: false,
				raw: true,
				options: { temperature: 0, num_predict: 1, seed: 1 },
				logprobs: true,
				top_logprobs: TOP_LOGPROBS,
			}),
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new DecideError(`ollama /api/generate ${res.status}: ${body.slice(0, 200)}`);
		}
		const json = (await res.json()) as { logprobs?: Array<{ top_logprobs?: TopLogprob[] }> };
		const top = json.logprobs?.[0]?.top_logprobs;
		if (!Array.isArray(top) || top.length === 0) {
			throw new DecideError(`ollama returned no logprobs for model "${this.model}" (does this Ollama build support logprobs?)`);
		}
		return top;
	}
}
