/**
 * Ollama adapter for the local model server layer.
 *
 * Model list and health both read GET {baseUrl}/api/tags, which is what every
 * call site did before the layer existed (Ollama has no /health; /api/tags is
 * its cheapest authenticated-free round trip, 8-17 ms locally).
 */

import {
	type LocalFetch,
	type LocalModelEntry,
	type LocalModelServer,
	type LocalRequestOptions,
	type LocalServerCapabilities,
	LocalServerHttpError,
	LocalServerResponseError,
	getWithSignal,
	lateBoundFetch,
} from "./server";

/**
 * Ollama's capabilities. MLX is Apple Silicon only: Ollama's MLX runner serves
 * the main brain on the M5 today. LM Studio also runs MLX there; llama-server
 * does not. Everywhere else Ollama serves GGUF through its llama.cpp engine.
 */
export function ollamaCapabilities(host: { platform: string; arch: string } = process): LocalServerCapabilities {
	return Object.freeze({
		listModels: true,
		pull: true,
		multiModel: true,
		mlx: host.platform === "darwin" && host.arch === "arm64",
		openaiChat: true,
		rawPrompt: true,
		embed: true,
		modelInfo: true,
	});
}

export const OLLAMA_CAPABILITIES: LocalServerCapabilities = ollamaCapabilities();

export interface OllamaServerOptions {
	/** Server root, used verbatim (no normalising: callers keep their own resolution in phase 1). */
	baseUrl: string;
	/** Injectable fetch. Defaults to globalThis.fetch, resolved per call. */
	fetch?: LocalFetch;
	/** Override the capability set (tests, or a host that is not this process's). */
	capabilities?: LocalServerCapabilities;
}

export function createOllamaServer(opts: OllamaServerOptions): LocalModelServer {
	const baseUrl = opts.baseUrl;
	const fetchImpl = opts.fetch ?? lateBoundFetch;
	const modelsUrl = `${baseUrl}/api/tags`;

	async function listModels(req?: LocalRequestOptions): Promise<LocalModelEntry[]> {
		const res = await getWithSignal(fetchImpl, modelsUrl, req);
		if (!res.ok) throw new LocalServerHttpError(modelsUrl, res.status);
		const data = (await res.json()) as unknown;
		if (data === null || typeof data !== "object") throw new LocalServerResponseError(modelsUrl, "body is not an object");
		const models = (data as { models?: unknown }).models;
		if (models === undefined || models === null) return [];
		if (!Array.isArray(models)) throw new LocalServerResponseError(modelsUrl, "`models` is not a list");
		return models as LocalModelEntry[];
	}

	async function isHealthy(req?: LocalRequestOptions): Promise<boolean> {
		try {
			const res = await getWithSignal(fetchImpl, modelsUrl, req);
			return res.ok;
		} catch {
			return false;
		}
	}

	return {
		kind: "ollama",
		baseUrl,
		capabilities: opts.capabilities ?? OLLAMA_CAPABILITIES,
		modelsUrl,
		healthUrl: modelsUrl,
		listModels,
		isHealthy,
	};
}
