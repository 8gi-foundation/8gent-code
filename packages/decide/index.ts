/**
 * @8gent/decide - Eight System One.
 *
 * A local decision engine. The harness asks typed questions about a
 * `state` string and gets calibrated probabilities back; calling code
 * owns every threshold. Backends: in-process llama.cpp (optional
 * node-llama-cpp), a local laya-serve, Ollama via token logprobs, and a
 * deterministic mock for tests.
 */

import { LayaBackend } from "./backends/laya";
import { LlamaCppBackend, type LlamaCppLoader, defaultLlamaCppLoader, llamaCppUnavailable, resolveGguf } from "./backends/llamacpp";
import { MockBackend } from "./backends/mock";
import { OllamaBackend, resolveOllamaHost } from "./backends/ollama";
import { SHARED_JUDGE_NUM_CTX, detectBackend, listOllamaModels, pickModel, type ProbeResult } from "./probe";
import {
	type ChoiceAnswer,
	type DecideBackend,
	DecideUnavailableError,
	type FetchLike,
	type NoulAnswer,
	type ScoreAnswer,
	type SystemOneRequest,
	type SystemOneResponse,
} from "./types";

export * from "./types";
export { LayaBackend, mapProbabilities, resolveLayaUrl } from "./backends/laya";
export { MockBackend } from "./backends/mock";
export {
	LlamaCppBackend,
	type LlamaCppLoader,
	disposeLlamaCpp,
	listOllamaGgufs,
	manifestName,
	resolveGguf,
} from "./backends/llamacpp";
export {
	OllamaBackend,
	buildPrompt,
	distributionFromLogprobs,
	letterLabels,
	modelPrefix,
	resolveOllamaHost,
	scoreLabels,
} from "./backends/ollama";
export { detectBackend, pickModel, MODEL_PREFERENCE, type ProbeResult } from "./probe";
export {
	bashGuard,
	modelGuard,
	stricterVerdict,
	guardState,
	promptControlText,
	stripShellComments,
	PROMPT_CONTROL_PATTERNS,
	BASH_GUARD_QUESTION,
	type BashGuardOptions,
	type BashGuardResult,
} from "./guard";
export { decideRules, BLOCK_RULES, type RuleResult, type RuleVerdict } from "./rules";

export type BackendSelection = "auto" | "llamacpp" | "laya" | "ollama" | "mock";

export interface DeciderOptions {
	/** A ready backend instance, or which kind to build. Default "auto". */
	backend?: DecideBackend | BackendSelection;
	/** Model override (Ollama name; llamacpp resolves it in the Ollama store). Defaults to env EIGHT_DECIDE_MODEL, then probe choice. */
	model?: string;
	timeoutMs?: number;
	/** Max memoised requests (FIFO eviction). 0 disables. Default 256. */
	cacheSize?: number;
	fetch?: FetchLike;
	env?: Record<string, string | undefined>;
	/** How to load the optional node-llama-cpp package; null disables llamacpp in auto. Tests inject a fake. */
	llamacppLoader?: LlamaCppLoader | null;
}

export interface Decider {
	/** Probability the answer to `prompt` about `state` is yes. */
	noul(state: string, prompt: string): Promise<NoulAnswer & Meta>;
	choice(state: string, prompt: string, options: string[]): Promise<ChoiceAnswer & Meta>;
	score(state: string, prompt: string, levels: string[]): Promise<ScoreAnswer & Meta>;
	ask(request: SystemOneRequest): Promise<SystemOneResponse>;
	/** Resolve (and cache) the backend without asking anything. */
	backend(): Promise<DecideBackend>;
}

interface Meta {
	backend: string;
	model: string;
	latencyMs: number;
}

async function buildBackend(opts: DeciderOptions): Promise<DecideBackend> {
	const sel = opts.backend ?? "auto";
	if (typeof sel === "object") return sel;
	const env = opts.env ?? process.env;
	const common = { timeoutMs: opts.timeoutMs, fetch: opts.fetch, env };
	if (sel === "mock") return new MockBackend();
	if (sel === "laya") return new LayaBackend(common);
	const model = opts.model ?? env.EIGHT_DECIDE_MODEL;
	if (sel === "llamacpp") {
		const loader = opts.llamacppLoader ?? defaultLlamaCppLoader;
		const gguf = resolveGguf(env, model);
		if (!gguf.path) throw new DecideUnavailableError(`llamacpp: ${gguf.note ?? "no EIGHT_DECIDE_GGUF, OLLAMA_MODELS or HOME to find a GGUF"}`);
		const missing = await llamaCppUnavailable(loader);
		if (missing) throw new DecideUnavailableError(missing);
		return new LlamaCppBackend({ model: gguf.model, modelPath: gguf.path, loader });
	}
	if (sel === "ollama") {
		if (model) return new OllamaBackend({ ...common, model });
		const host = resolveOllamaHost(env);
		const installed = await listOllamaModels(opts.fetch ?? ((i, n) => fetch(i, n)), host, 1_000).catch((err: Error) => {
			throw new DecideUnavailableError(`ollama unreachable at ${host}: ${err.message}`);
		});
		const picked = pickModel(installed);
		if (!picked) throw new DecideUnavailableError(`ollama at ${host} has no usable models installed`);
		return new OllamaBackend({ ...common, model: picked, host });
	}
	const probe: ProbeResult = await detectBackend({
		fetch: opts.fetch,
		env: model ? { ...env, EIGHT_DECIDE_MODEL: model } : env,
		llamacppLoader: opts.llamacppLoader,
	});
	if (probe.backend === "llamacpp" && probe.model && probe.path) {
		return new LlamaCppBackend({ model: probe.model, modelPath: probe.path, loader: opts.llamacppLoader ?? undefined });
	}
	if (probe.backend === "laya") return new LayaBackend({ ...common, url: probe.url ?? undefined });
	if (probe.backend === "ollama" && probe.model) {
		const numCtx = probe.shared ? SHARED_JUDGE_NUM_CTX : undefined;
		return new OllamaBackend({ ...common, model: probe.model, host: probe.url ?? undefined, numCtx });
	}
	throw new DecideUnavailableError(`no decide backend available: ${probe.notes.join("; ")}`);
}

export function createDecider(opts: DeciderOptions = {}): Decider {
	let pending: Promise<DecideBackend> | null = null;
	const backend = () => {
		if (!pending) {
			pending = buildBackend(opts);
			// A failed probe must not poison later calls (the server may come up).
			pending.catch(() => {
				pending = null;
			});
		}
		return pending;
	};
	// Ollama's float output drifts in the 5th decimal between identical calls
	// (KV-cache reuse), so a bounded memo is what makes same input -> same output.
	const cacheSize = opts.cacheSize ?? 256;
	const memo = new Map<string, SystemOneResponse>();
	const ask = async (request: SystemOneRequest) => {
		const key = cacheSize > 0 ? JSON.stringify(request) : "";
		const hit = cacheSize > 0 ? memo.get(key) : undefined;
		if (hit) return structuredClone(hit);
		const res = await (await backend()).ask(request);
		if (cacheSize > 0) {
			if (memo.size >= cacheSize) memo.delete(memo.keys().next().value as string);
			memo.set(key, structuredClone(res));
		}
		return res;
	};
	const one = async <T>(request: SystemOneRequest): Promise<T & Meta> => {
		const res = await ask(request);
		return { ...(res.answers[0] as T), backend: res.backend, model: res.model, latencyMs: res.latencyMs };
	};
	return {
		backend,
		ask,
		noul: (state, prompt) => one<NoulAnswer>({ state, questions: [{ id: "q", kind: "noul", prompt }] }),
		choice: (state, prompt, options) => one<ChoiceAnswer>({ state, questions: [{ id: "q", kind: "choice", prompt, options }] }),
		score: (state, prompt, levels) => one<ScoreAnswer>({ state, questions: [{ id: "q", kind: "score", prompt, levels }] }),
	};
}
