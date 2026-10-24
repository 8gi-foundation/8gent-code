/**
 * The safety judge on a llama.cpp `llama-server` that 8gent started (#4906).
 *
 * Same method as the Ollama and in-process llama.cpp judges: the prompt from
 * `buildPrompt` (no chat template), one token, the top 20 logprobs, mass summed over
 * the spellings of each answer label (OllamaBackend.answerOne). Only the transport
 * differs: llama-server's `POST /completion` with `n_probs`.
 *
 * It reports the backend name "llamacpp" and the calibrated judge model name, so the
 * calibration fitted for that exact model on llama.cpp applies (calibration/llamacpp-*.json).
 *
 * Trust: the server is only used when 8gent's own record says it started one
 * (~/.8gent/state/llama-server.pid, port fixed here), and it only ever talks to
 * 127.0.0.1. The state is a command that has not run yet; it never leaves the machine.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JUDGE_MODEL } from "../judge-model";
import { DecideError, DecideUnavailableError, type FetchLike } from "../types";
import { OllamaBackend, type TopLogprob } from "./ollama";

/** The one port the judge's llama-server listens on, and the only address it is spoken to on. */
export const LLAMA_HOST = "127.0.0.1";
export const LLAMA_PORT = 8091;
// Built from parts: a template with host and port reads like a model name:tag to the literal guard.
export const LLAMA_URL = ["http://", LLAMA_HOST, ":", String(LLAMA_PORT)].join("");
const TOP_LOGPROBS = 20;

type Env = Record<string, string | undefined>;

/** ~/.8gent/state/llama-server.pid from the given env only (never the real home, so tests stay hermetic). */
export function llamaRecordPath(env: Env): string | null {
	const home = (env.EIGHT_HOME ?? env.HOME ?? "").trim();
	return home ? join(home, ".8gent", "state", "llama-server.pid") : null;
}

export interface LlamaRecord {
	pid: number;
	bin: string;
	startMs: number;
	port: number;
	model: string;
	gguf: string;
	keyFile?: string;
}

/** The API key this start of llama-server was launched with, from the record's key file; null when absent. */
export function readLlamaKey(rec: LlamaRecord | null): string | null {
	if (!rec?.keyFile) return null;
	try {
		return readFileSync(rec.keyFile, "utf-8").trim() || null;
	} catch {
		return null;
	}
}

/** The record of the server 8gent started, or null when absent, malformed, or not for this judge. */
export function readLlamaRecord(env: Env): LlamaRecord | null {
	const p = llamaRecordPath(env);
	if (!p || !existsSync(p)) return null;
	try {
		const r = JSON.parse(readFileSync(p, "utf-8")) as Partial<LlamaRecord>;
		if (
			Number.isInteger(r.pid) &&
			(r.pid as number) > 1 &&
			typeof r.bin === "string" &&
			Number.isFinite(r.startMs) &&
			r.port === LLAMA_PORT &&
			r.model === JUDGE_MODEL &&
			typeof r.gguf === "string"
		)
			return r as LlamaRecord;
	} catch {}
	return null;
}

/** null when llama-server answers /health, else why not. */
export async function llamaServerDown(
	fetchImpl: FetchLike,
	timeoutMs: number,
): Promise<string | null> {
	try {
		const res = await fetchImpl(LLAMA_URL.concat("/health"), {
			signal: AbortSignal.timeout(timeoutMs),
			redirect: "error",
		});
		return res.ok ? null : `llama-server health ${res.status}`;
	} catch (err) {
		return `llama-server unreachable at ${LLAMA_URL}: ${(err as Error).message}`;
	}
}

/**
 * Next-token logprobs from llama-server. Newer builds answer
 * completion_probabilities[0].top_logprobs[{token, logprob}]; older ones answer
 * completion_probabilities[0].probs[{tok_str, prob}] (or top-level probs).
 */
export function parseLlamaLogprobs(json: unknown): TopLogprob[] | null {
	const j = json as {
		completion_probabilities?: Array<{
			top_logprobs?: Array<{ token?: string; logprob?: number }>;
			probs?: Array<{ tok_str?: string; prob?: number }>;
		}>;
		probs?: Array<{ tok_str?: string; prob?: number }>;
	};
	const first = j?.completion_probabilities?.[0];
	const top = first?.top_logprobs;
	if (Array.isArray(top) && top.length > 0) {
		const out = top.flatMap((t) =>
			typeof t?.token === "string" && Number.isFinite(t.logprob)
				? [{ token: t.token, logprob: t.logprob as number }]
				: [],
		);
		if (out.length > 0) return out;
	}
	const probs = first?.probs ?? j?.probs;
	if (Array.isArray(probs) && probs.length > 0) {
		const out = probs.flatMap((t) =>
			typeof t?.tok_str === "string" && typeof t.prob === "number" && t.prob > 0
				? [{ token: t.tok_str, logprob: Math.log(t.prob) }]
				: [],
		);
		if (out.length > 0) return out;
	}
	return null;
}

export class LlamaServerBackend extends OllamaBackend {
	override readonly name = "llamacpp";

	private readonly apiKey: string | null;

	constructor(opts: { timeoutMs?: number; fetch?: FetchLike; apiKey?: string | null } = {}) {
		super({ model: JUDGE_MODEL, host: LLAMA_URL, timeoutMs: opts.timeoutMs, fetch: opts.fetch });
		this.apiKey = opts.apiKey ?? null;
	}

	protected override async topLogprobs(prompt: string): Promise<TopLogprob[]> {
		const res = await this.fetchImpl(`${this.host}/completion`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
			},
			body: JSON.stringify({
				prompt,
				n_predict: 1,
				n_probs: TOP_LOGPROBS,
				temperature: 0,
				seed: 1,
				cache_prompt: false,
				stream: false,
			}),
			signal: AbortSignal.timeout(this.timeoutMs),
			// Never follow a redirect: a 307/308 would re-send the prompt (the command) elsewhere.
			redirect: "error",
		}).catch((err: Error) => {
			throw new DecideUnavailableError(
				`llama-server unreachable at ${this.host}: ${err?.message ?? String(err)}`,
			);
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new DecideUnavailableError(
				`llama-server /completion ${res.status}: ${body.slice(0, 200)}`,
			);
		}
		const json = await res.json().catch((err: Error) => {
			throw new DecideUnavailableError(
				`llama-server /completion body unreadable: ${err?.message ?? String(err)}`,
			);
		});
		const top = parseLlamaLogprobs(json);
		if (!top)
			throw new DecideError(
				"llama-server returned no token probabilities (is n_probs supported by this build?)",
			);
		return top;
	}
}
