/**
 * Backend detection.
 *
 * Order: in-process llama.cpp (only when the optional node-llama-cpp
 * package loads AND a GGUF resolves, see backends/llamacpp.ts; an explicit
 * EIGHT_DECIDE_MODEL with no GGUF skips llamacpp rather than being
 * substituted by another model), then a
 * local laya-serve (LAYA_URL), then Ollama (OLLAMA_HOST).
 * The Ollama model is chosen from what is actually installed: env
 * EIGHT_DECIDE_MODEL wins if it is installed, otherwise the first match
 * of a preference order of name substrings (smallest first within a
 * match), otherwise the smallest installed non-embedding model. There is
 * no hardcoded model list - only substrings to rank what `/api/tags` says.
 *
 * Shared judge (EIGHT_S1_SHARED_JUDGE=1, #3162): before loading a private
 * copy in-process, ask the machine's local model server (Ollama, through the
 * local-model-server layer) whether it already serves the judge. One server
 * process holds the model once for every agent, child and tab on the machine.
 * Its host is pinned to this machine (EIGHT_DECIDE_OLLAMA_HOST, default
 * localhost:11434), never the chat model's OLLAMA_HOST, which can point at a
 * remote box. The flag changes where the judge runs, never which model
 * judges: when a GGUF resolves for llama.cpp, the shared server is used only
 * if it serves that same model. Anything short of that falls back to the
 * in-process path unchanged.
 *
 * Lost shared judge (#3162 bar 4): createDecider re-probes with avoidShared
 * when the shared server stops answering, so the in-process judge takes over
 * for the rest of that session. New sessions probe fresh and use the shared
 * server again once it is back.
 */

import { resolveLayaUrl } from "./backends/laya";
import { type LlamaCppLoader, defaultLlamaCppLoader, llamaCppUnavailable, resolveGguf } from "./backends/llamacpp";
import { resolveOllamaHost } from "./backends/ollama";
import { LocalServerHttpError, LocalServerResponseError, createOllamaServer, isOllamaEnabled } from "../local-model-server";
import { DEFAULT_OLLAMA_BASE_URL, normaliseOllamaHost } from "../local-model-server/ollama-host";
import type { FetchLike } from "./types";

/**
 * Ranking substrings, most preferred first. Selene (an evaluator model) leads
 * because it was the only model in the 2026-09-28 eval that hard-blocked at
 * the default thresholds (95% accuracy, AUC 1.000; see README Results).
 * Small instruct models that emit clean single-token answers come next,
 * ahead of large or reasoning ones.
 */
export const MODEL_PREFERENCE = ["selene", "llama3.2", "llama3.1", "qwen2.5", "gemma", "phi", "minicpm", "mistral", "qwen3", "llama"];

/** Substrings that mark models unable to answer (embedding-only). */
const EXCLUDE = ["embed"];

const PROBE_TIMEOUT_MS = 1_000;

export interface InstalledModel {
	name: string;
	size?: number;
}

export interface ProbeResult {
	backend: "llamacpp" | "laya" | "ollama" | "none";
	model: string | null;
	/** Base URL of the chosen backend, null when none or in-process. */
	url: string | null;
	/** GGUF file path when the backend is llamacpp. */
	path?: string;
	/** True when the backend is the machine's shared judge server (EIGHT_S1_SHARED_JUDGE). */
	shared?: boolean;
	os: string;
	arch: string;
	/** Why each earlier backend was skipped, plus the final reason when none. */
	notes: string[];
}

export interface ProbeOptions {
	fetch?: FetchLike;
	env?: Record<string, string | undefined>;
	timeoutMs?: number;
	/** How to load the optional node-llama-cpp package; null skips the llamacpp probe. */
	llamacppLoader?: LlamaCppLoader | null;
	/**
	 * Re-probe after the shared judge was lost mid-session (#3162 bar 4): try the
	 * in-process judge before the shared server, so a session does not keep
	 * leaning on a server that just failed it. The shared server is still asked
	 * when no in-process judge loads (it may be back).
	 */
	avoidShared?: boolean;
}

export function pickModel(installed: InstalledModel[], override?: string): string | null {
	const usable = installed.filter((m) => m?.name && !EXCLUDE.some((x) => m.name.toLowerCase().includes(x)));
	if (override) {
		const hit = usable.find((m) => m.name === override || m.name === `${override}:latest`);
		if (hit) return hit.name;
	}
	const bySize = (a: InstalledModel, b: InstalledModel) =>
		(a.size ?? Number.MAX_SAFE_INTEGER) - (b.size ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name);
	for (const pref of MODEL_PREFERENCE) {
		const matches = usable.filter((m) => m.name.toLowerCase().includes(pref)).sort(bySize);
		if (matches.length > 0) return matches[0].name;
	}
	const rest = [...usable].sort(bySize);
	return rest[0]?.name ?? null;
}

async function layaUp(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<string | null> {
	try {
		const res = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
		if (res.ok) return null;
		return `laya health ${res.status}`;
	} catch (err) {
		return `laya unreachable at ${url}: ${(err as Error).message}`;
	}
}

export async function listOllamaModels(fetchImpl: FetchLike, host: string, timeoutMs: number): Promise<InstalledModel[]> {
	const server = createOllamaServer({ baseUrl: host, fetch: fetchImpl });
	try {
		return (await server.listModels({ signal: AbortSignal.timeout(timeoutMs) })) as InstalledModel[];
	} catch (err) {
		if (err instanceof LocalServerHttpError) throw new Error(`ollama /api/tags ${err.status}`);
		if (err instanceof LocalServerResponseError) return [];
		throw err;
	}
}

/**
 * Context window the shared judge asks for: the same 4096 the in-process
 * backend loads with (llamacpp DEFAULT_CONTEXT_SIZE). A guard prompt is a few
 * hundred tokens, and every client must ask for the same value or the server
 * reloads the model between them.
 */
export const SHARED_JUDGE_NUM_CTX = 4096;

/** True when EIGHT_S1_SHARED_JUDGE asks for the machine's shared judge server. */
export function sharedJudgeEnabled(env: Record<string, string | undefined>): boolean {
	const v = env.EIGHT_S1_SHARED_JUDGE?.trim().toLowerCase();
	return v === "1" || v === "true" || v === "on";
}

/**
 * The shared judge's server root: EIGHT_DECIDE_OLLAMA_HOST, else this
 * machine's default Ollama. Deliberately not OLLAMA_HOST / OLLAMA_BASE_URL:
 * those follow the chat model, which may live on another machine.
 */
export function resolveSharedJudgeHost(env: Record<string, string | undefined>): string {
	return normaliseOllamaHost(env.EIGHT_DECIDE_OLLAMA_HOST) ?? DEFAULT_OLLAMA_BASE_URL;
}

/**
 * Ask the shared server for the judge. Returns the model to judge with, or a
 * note saying why the shared judge was skipped. `required` is the model the
 * in-process path would load; when set, only that exact model is accepted.
 */
async function sharedJudge(
	fetchImpl: FetchLike,
	host: string,
	env: Record<string, string | undefined>,
	required: string | null,
	timeoutMs: number,
): Promise<{ model: string } | { note: string }> {
	const server = createOllamaServer({ baseUrl: host, fetch: fetchImpl });
	// The judge reads next-token logprobs from a raw prompt; a server without raw prompts cannot judge.
	if (!server.capabilities.rawPrompt) return { note: `shared judge: ${server.kind} at ${host} has no raw prompt endpoint` };
	let installed: InstalledModel[];
	try {
		installed = await listOllamaModels(fetchImpl, host, timeoutMs);
	} catch (err) {
		return { note: `shared judge unreachable at ${host}: ${(err as Error).message}` };
	}
	if (required) {
		const hit = installed.find((m) => m?.name === required || m?.name === `${required}:latest`);
		return hit ? { model: hit.name } : { note: `shared judge at ${host} does not serve ${required}` };
	}
	const model = pickModel(installed, env.EIGHT_DECIDE_MODEL);
	return model ? { model } : { note: `shared judge at ${host} has no usable models installed` };
}

export async function detectBackend(opts: ProbeOptions = {}): Promise<ProbeResult> {
	const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
	const env = opts.env ?? process.env;
	const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
	const base = { os: process.platform, arch: process.arch };
	const notes: string[] = [];

	const loader = opts.llamacppLoader === undefined ? defaultLlamaCppLoader : opts.llamacppLoader;
	// GGUF first: a cheap file check, so the package is only imported when there is a model to load.
	const gguf = loader ? resolveGguf(env) : null;

	const inProcess = async (): Promise<ProbeResult | null> => {
		if (!loader || !gguf) return null;
		if (gguf.path) {
			const missing = await llamaCppUnavailable(loader);
			if (missing === null) return { ...base, backend: "llamacpp", model: gguf.model, url: null, path: gguf.path, notes };
			notes.push(missing);
		} else if (gguf.note) {
			notes.push(`llamacpp: ${gguf.note}`);
		}
		return null;
	};

	// After losing the shared judge, the in-process judge goes first (the note says why).
	if (opts.avoidShared) {
		notes.push("shared judge lost mid-session: trying the in-process judge first");
		const local = await inProcess();
		if (local) return local;
	}

	// An explicit EIGHT_DECIDE_GGUF names a file, not a served model: it stays in-process.
	// The shared server is Ollama: with another local server selected (#3149), Ollama is off and not asked.
	if (sharedJudgeEnabled(env) && isOllamaEnabled(env) && !env.EIGHT_DECIDE_GGUF?.trim()) {
		const host = resolveSharedJudgeHost(env);
		const shared = await sharedJudge(fetchImpl, host, env, gguf?.path ? gguf.model : null, timeoutMs);
		if ("model" in shared) return { ...base, backend: "ollama", model: shared.model, url: host, shared: true, notes };
		notes.push(shared.note);
	}

	if (!opts.avoidShared) {
		const local = await inProcess();
		if (local) return local;
	}

	const layaUrl = resolveLayaUrl(env);
	const layaNote = await layaUp(fetchImpl, layaUrl, timeoutMs);
	if (layaNote === null) {
		return { ...base, backend: "laya", model: env.EIGHT_DECIDE_MODEL || "laya", url: layaUrl, notes };
	}
	notes.push(layaNote);

	// Another local server is selected (#3149): Ollama is off, so it is not asked.
	if (!isOllamaEnabled(env)) {
		notes.push("ollama: not used, EIGHT_LOCAL_SERVER selects another server");
		return { ...base, backend: "none", model: null, url: null, notes };
	}
	const host = resolveOllamaHost(env);
	try {
		const installed = await listOllamaModels(fetchImpl, host, timeoutMs);
		const model = pickModel(installed, env.EIGHT_DECIDE_MODEL);
		if (model) return { ...base, backend: "ollama", model, url: host, notes };
		notes.push(`ollama at ${host} has no usable models installed`);
	} catch (err) {
		notes.push(`ollama unreachable at ${host}: ${(err as Error).message}`);
	}
	return { ...base, backend: "none", model: null, url: null, notes };
}
