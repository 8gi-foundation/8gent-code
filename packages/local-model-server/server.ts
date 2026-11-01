/**
 * Local model server layer.
 *
 * One interface in front of every HTTP call the harness makes to a model
 * server on this machine or the LAN. Ollama, llama-server (llama.cpp) and
 * LM Studio are meant to be equal choices behind it, each declaring what it
 * can do through `capabilities` instead of callers assuming Ollama.
 *
 * Phase 1 (server.ts + ollama.ts): the interface, the Ollama adapter, and the
 * model-list and health call sites moved behind it with no behaviour change.
 * The adapter takes the base URL it is given verbatim; host resolution stays
 * with each caller for now, so nothing that used to reach a host stops
 * reaching it. Design and later phases: #3149.
 *
 * Phase 2 (llama-server.ts + select.ts): the llama-server adapter, and
 * EIGHT_LOCAL_SERVER=llama-server, which makes llama-server the local server
 * and turns Ollama off for the process (see select.ts).
 */

export type LocalServerKind = "ollama" | "llama-server" | "lmstudio";

/**
 * What a server can do, as known facts about that server, not probed guesses.
 * A caller that needs one of these checks the flag before calling, so a
 * machine with only llama-server takes a different path instead of failing on
 * an Ollama-only endpoint.
 */
export interface LocalServerCapabilities {
	/** Enumerates the models it can serve (Ollama /api/tags, OpenAI /v1/models). */
	readonly listModels: boolean;
	/** Can download a model on request over HTTP (Ollama /api/pull). */
	readonly pull: boolean;
	/** Serves more than one model from one process, loading on demand. */
	readonly multiModel: boolean;
	/** Runs MLX weights on Apple Silicon. */
	readonly mlx: boolean;
	/** OpenAI-compatible /v1/chat/completions. */
	readonly openaiChat: boolean;
	/** Raw prompt completion that bypasses the server's chat template and tool parser. */
	readonly rawPrompt: boolean;
	/** Embeddings endpoint. */
	readonly embed: boolean;
	/** Per-model metadata such as the chat template (Ollama /api/show). */
	readonly modelInfo: boolean;
}

/**
 * One model as the server lists it. `name` is always present; everything else
 * the server returned is kept as-is (Ollama sends size, digest, details), so a
 * caller that ranks by size keeps working without a second request.
 */
export interface LocalModelEntry {
	name: string;
	size?: number;
	[key: string]: unknown;
}

export interface LocalRequestOptions {
	/** Caller-owned cancellation/timeout. Omitted means no timeout, as fetch does. */
	signal?: AbortSignal;
}

export type LocalFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface LocalModelServer {
	readonly kind: LocalServerKind;
	/** Server root, exactly as the caller supplied it. */
	readonly baseUrl: string;
	readonly capabilities: LocalServerCapabilities;
	/** The URL `listModels` reads. For callers that probe without this object (sync child probes). */
	readonly modelsUrl: string;
	/** The URL `isHealthy` reads. */
	readonly healthUrl: string;
	/**
	 * The raw model list. Rejects with LocalServerHttpError on a non-2xx answer,
	 * with LocalServerResponseError on a body that is not a model list, and with
	 * the fetch error itself (TimeoutError, AbortError, TypeError) when the
	 * server is not reachable, so a caller can still tell a timeout from a refusal.
	 */
	listModels(opts?: LocalRequestOptions): Promise<LocalModelEntry[]>;
	/** True on a 2xx from the health URL. Never throws. */
	isHealthy(opts?: LocalRequestOptions): Promise<boolean>;
}

/** The server answered, with a non-2xx status. */
export class LocalServerHttpError extends Error {
	readonly status: number;
	readonly url: string;
	constructor(url: string, status: number) {
		super(`${url} answered HTTP ${status}`);
		this.name = "LocalServerHttpError";
		this.status = status;
		this.url = url;
	}
}

/** The server answered 2xx with a body that is not the expected shape. */
export class LocalServerResponseError extends Error {
	readonly url: string;
	constructor(url: string, message: string) {
		super(`${url}: ${message}`);
		this.name = "LocalServerResponseError";
		this.url = url;
	}
}

/**
 * Call `fetchImpl` the way the pre-layer call sites did: with one argument when
 * there is no signal, with `{ signal }` when there is. Keeps spies and the wire
 * request identical to before the move.
 */
export function getWithSignal(fetchImpl: LocalFetch, url: string, opts?: LocalRequestOptions): Promise<Response> {
	return opts?.signal ? fetchImpl(url, { signal: opts.signal }) : fetchImpl(url);
}

/** Resolve fetch at call time, so a test that swaps globalThis.fetch is honoured. */
export const lateBoundFetch: LocalFetch = (input, init) =>
	init === undefined ? globalThis.fetch(input) : globalThis.fetch(input, init);
