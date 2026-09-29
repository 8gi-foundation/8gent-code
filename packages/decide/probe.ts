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
 */

import { resolveLayaUrl } from "./backends/laya";
import { type LlamaCppLoader, defaultLlamaCppLoader, llamaCppUnavailable, resolveGguf } from "./backends/llamacpp";
import { resolveOllamaHost } from "./backends/ollama";
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
	const res = await fetchImpl(`${host}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) throw new Error(`ollama /api/tags ${res.status}`);
	const json = (await res.json()) as { models?: InstalledModel[] };
	return Array.isArray(json.models) ? json.models : [];
}

export async function detectBackend(opts: ProbeOptions = {}): Promise<ProbeResult> {
	const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
	const env = opts.env ?? process.env;
	const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
	const base = { os: process.platform, arch: process.arch };
	const notes: string[] = [];

	const loader = opts.llamacppLoader === undefined ? defaultLlamaCppLoader : opts.llamacppLoader;
	if (loader) {
		// GGUF first: a cheap file check, so the package is only imported when there is a model to load.
		const gguf = resolveGguf(env);
		if (gguf.path) {
			const missing = await llamaCppUnavailable(loader);
			if (missing === null) return { ...base, backend: "llamacpp", model: gguf.model, url: null, path: gguf.path, notes };
			notes.push(missing);
		} else if (gguf.note) {
			notes.push(`llamacpp: ${gguf.note}`);
		}
	}

	const layaUrl = resolveLayaUrl(env);
	const layaNote = await layaUp(fetchImpl, layaUrl, timeoutMs);
	if (layaNote === null) {
		return { ...base, backend: "laya", model: env.EIGHT_DECIDE_MODEL || "laya", url: layaUrl, notes };
	}
	notes.push(layaNote);

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
