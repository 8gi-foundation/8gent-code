/**
 * llama-server (llama.cpp) adapter for the local model server layer.
 *
 * llama-server speaks the OpenAI API: the model list is GET {baseUrl}/v1/models
 * (`data[].id`), and it has a real GET /health (200 once the model is loaded,
 * 503 while loading). It serves GGUF only, no MLX, and has no HTTP pull: a
 * model arrives by `-m file.gguf` or `-hf repo:tag` at launch.
 *
 * One model per process by default. Router mode (`llama-server --models-dir`,
 * no model argument) lists and loads several, but that is a launch choice this
 * adapter cannot see from outside, so `multiModel` stays false: a caller that
 * needs a second model starts a second server rather than assuming one.
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

export const LLAMA_SERVER_CAPABILITIES: LocalServerCapabilities = Object.freeze({
	listModels: true,
	pull: false,
	multiModel: false,
	mlx: false,
	openaiChat: true,
	// POST /completion takes a prompt with no chat template and no tool parser.
	rawPrompt: true,
	// Only when launched with --embeddings, which is not visible from outside.
	embed: false,
	// GET /props carries the chat template.
	modelInfo: true,
});

export interface LlamaServerOptions {
	/** Server root, without "/v1" (e.g. http://127.0.0.1:8080). Used verbatim. */
	baseUrl: string;
	fetch?: LocalFetch;
}

export function createLlamaServer(opts: LlamaServerOptions): LocalModelServer {
	const baseUrl = opts.baseUrl;
	const fetchImpl = opts.fetch ?? lateBoundFetch;
	const modelsUrl = `${baseUrl}/v1/models`;
	const healthUrl = `${baseUrl}/health`;

	async function listModels(req?: LocalRequestOptions): Promise<LocalModelEntry[]> {
		const res = await getWithSignal(fetchImpl, modelsUrl, req);
		if (!res.ok) throw new LocalServerHttpError(modelsUrl, res.status);
		const body = (await res.json()) as unknown;
		if (body === null || typeof body !== "object") throw new LocalServerResponseError(modelsUrl, "body is not an object");
		const data = (body as { data?: unknown }).data;
		if (data === undefined || data === null) return [];
		if (!Array.isArray(data)) throw new LocalServerResponseError(modelsUrl, "`data` is not a list");
		return data.flatMap((m) => {
			const id = m && typeof m === "object" ? (m as { id?: unknown }).id : undefined;
			return typeof id === "string" && id ? [{ ...(m as object), name: id }] : [];
		});
	}

	async function isHealthy(req?: LocalRequestOptions): Promise<boolean> {
		try {
			return (await getWithSignal(fetchImpl, healthUrl, req)).ok;
		} catch {
			return false;
		}
	}

	return {
		kind: "llama-server",
		baseUrl,
		capabilities: LLAMA_SERVER_CAPABILITIES,
		modelsUrl,
		healthUrl,
		listModels,
		isHealthy,
	};
}
