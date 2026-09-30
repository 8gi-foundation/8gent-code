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

/** A built backend, and whether it is the machine's shared judge server (the only kind that fails over). */
interface Built {
	backend: DecideBackend;
	shared: boolean;
}

async function buildBackend(opts: DeciderOptions, avoidShared = false): Promise<Built> {
	const sel = opts.backend ?? "auto";
	const local = (backend: DecideBackend): Built => ({ backend, shared: false });
	if (typeof sel === "object") return local(sel);
	const env = opts.env ?? process.env;
	const common = { timeoutMs: opts.timeoutMs, fetch: opts.fetch, env };
	if (sel === "mock") return local(new MockBackend());
	if (sel === "laya") return local(new LayaBackend(common));
	const model = opts.model ?? env.EIGHT_DECIDE_MODEL;
	if (sel === "llamacpp") {
		const loader = opts.llamacppLoader ?? defaultLlamaCppLoader;
		const gguf = resolveGguf(env, model);
		if (!gguf.path) throw new DecideUnavailableError(`llamacpp: ${gguf.note ?? "no EIGHT_DECIDE_GGUF, OLLAMA_MODELS or HOME to find a GGUF"}`);
		const missing = await llamaCppUnavailable(loader);
		if (missing) throw new DecideUnavailableError(missing);
		return local(new LlamaCppBackend({ model: gguf.model, modelPath: gguf.path, loader }));
	}
	if (sel === "ollama") {
		if (model) return local(new OllamaBackend({ ...common, model }));
		const host = resolveOllamaHost(env);
		const installed = await listOllamaModels(opts.fetch ?? ((i, n) => fetch(i, n)), host, 1_000).catch((err: Error) => {
			throw new DecideUnavailableError(`ollama unreachable at ${host}: ${err.message}`);
		});
		const picked = pickModel(installed);
		if (!picked) throw new DecideUnavailableError(`ollama at ${host} has no usable models installed`);
		return local(new OllamaBackend({ ...common, model: picked, host }));
	}
	const probe: ProbeResult = await detectBackend({
		fetch: opts.fetch,
		env: model ? { ...env, EIGHT_DECIDE_MODEL: model } : env,
		llamacppLoader: opts.llamacppLoader,
		avoidShared,
	});
	if (probe.backend === "llamacpp" && probe.model && probe.path) {
		return local(new LlamaCppBackend({ model: probe.model, modelPath: probe.path, loader: opts.llamacppLoader ?? undefined }));
	}
	if (probe.backend === "laya") return local(new LayaBackend({ ...common, url: probe.url ?? undefined }));
	if (probe.backend === "ollama" && probe.model) {
		const numCtx = probe.shared ? SHARED_JUDGE_NUM_CTX : undefined;
		const backend = new OllamaBackend({ ...common, model: probe.model, host: probe.url ?? undefined, numCtx });
		return { backend, shared: probe.shared === true };
	}
	throw new DecideUnavailableError(`no decide backend available: ${probe.notes.join("; ")}`);
}

/**
 * Re-probe backoff after the shared judge is lost (#3162 bar 4). A re-probe
 * that finds no judge is not repeated for this long, doubling per failure.
 * Per process, so N tabs cost at most N `/api/tags` per window, never a storm.
 */
export const FAILOVER_BACKOFF_MS = 2_000;
export const FAILOVER_BACKOFF_MAX_MS = 60_000;

export function createDecider(opts: DeciderOptions = {}): Decider {
	let pending: Promise<Built> | null = null;
	const built = () => {
		if (!pending) {
			const p = buildBackend(opts);
			pending = p;
			// A failed probe must not poison later calls (the server may come up).
			p.catch(() => {
				if (pending === p) pending = null;
			});
		}
		return pending;
	};
	const backend = async () => (await built()).backend;

	// Lost shared judge: one re-probe in flight at a time, backed off when it finds nothing.
	let failover: Promise<Built> | null = null;
	let retryAt = 0;
	let backoffMs = FAILOVER_BACKOFF_MS;
	const recover = async (lost: Built, cause: unknown): Promise<Built> => {
		if (failover) return failover;
		// A call that failed after the swap uses the new backend; it does not probe again.
		const current = pending ? await pending.catch(() => null) : null;
		if (current && current !== lost) return current;
		if (failover) return failover;
		if (Date.now() < retryAt) throw cause;
		const backOff = () => {
			retryAt = Date.now() + backoffMs;
			backoffMs = Math.min(backoffMs * 2, FAILOVER_BACKOFF_MAX_MS);
		};
		const why = (e: unknown) => (e as Error)?.message ?? String(e);
		const p = buildBackend(opts, true).then(
			(next) => {
				pending = Promise.resolve(next);
				// Landing on the shared server again (no in-process judge) keeps the backoff, so a flapping server is not re-probed per verdict.
				if (next.shared) backOff();
				else backoffMs = FAILOVER_BACKOFF_MS;
				return next;
			},
			(err: unknown) => {
				backOff();
				throw new DecideUnavailableError(`shared judge lost (${why(cause)}) and nothing to fail over to: ${why(err)}`);
			},
		);
		failover = p;
		const clear = () => {
			if (failover === p) failover = null;
		};
		p.then(clear, clear);
		return p;
	};
	const judge = async (request: SystemOneRequest): Promise<SystemOneResponse> => {
		const b = await built();
		try {
			return await b.backend.ask(request);
		} catch (err) {
			if (!b.shared || !(err instanceof DecideUnavailableError)) throw err;
			const next = await recover(b, err);
			return next.backend.ask(request);
		}
	};
	// Ollama's float output drifts in the 5th decimal between identical calls
	// (KV-cache reuse), so a bounded memo is what makes same input -> same output.
	const cacheSize = opts.cacheSize ?? 256;
	const memo = new Map<string, SystemOneResponse>();
	const ask = async (request: SystemOneRequest) => {
		const key = cacheSize > 0 ? JSON.stringify(request) : "";
		const hit = cacheSize > 0 ? memo.get(key) : undefined;
		if (hit) return structuredClone(hit);
		const res = await judge(request);
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
