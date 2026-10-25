/**
 * Context window for the model that ran the turn (#3321).
 *
 * The HUD bar used to divide by a constant 128000. This resolves the real
 * window instead: provider metadata first, then what the local server
 * reports, else an explicit "unknown". It never invents a number: unknown is
 * a state the bar shows as such.
 */

export type ContextWindowSource = "provider" | "server" | "override" | "unknown";

export interface ContextWindow {
	/** Tokens the model can hold, or null when nothing reported it. */
	window: number | null;
	source: ContextWindowSource;
}

export interface ResolveContextWindowOptions {
	provider: string;
	model: string;
	fetchImpl?: typeof fetch;
	ollamaBaseUrl?: string;
	llamaServerUrl?: string;
	/** The provider's own OpenAI-compatible base URL (e.g. MiniMax). Its models list is asked. */
	baseUrl?: string;
	/** The key the owner already configured for that provider, sent only to that baseUrl. */
	apiKey?: string;
	timeoutMs?: number;
	/** Aborts in-flight requests, e.g. when the model changes or the HUD unmounts. */
	signal?: AbortSignal;
}

export const UNKNOWN_WINDOW: ContextWindow = { window: null, source: "unknown" };

/** Above any shipping model (10M tokens) with headroom. A larger value is
 *  junk from the wire, not a reading, so it falls to unknown. */
export const MAX_PLAUSIBLE_WINDOW = 100_000_000;

const positive = (n: unknown): number | null =>
	typeof n === "number" && Number.isFinite(n) && n >= 1 && n <= MAX_PLAUSIBLE_WINDOW
		? Math.floor(n)
		: null;

async function getJson(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<unknown> {
	try {
		const timeout = AbortSignal.timeout(timeoutMs);
		const res = await fetchImpl(url, {
			...init,
			redirect: "error",
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (!res.ok) return null;
		// Hardening (8SO): refuse oversized bodies (1 MiB cap on a declared length).
		const declared = Number(res.headers?.get?.("content-length") ?? 0);
		if (declared > 1_048_576) return null;
		return await res.json();
	} catch {
		return null;
	}
}

/** The window fields that live providers' models lists really carry, in order:
 *  `context_length` (OpenRouter, Together, Fireworks), `context_window` (Groq),
 *  `max_context_length` (Mistral, LM Studio), `max_model_len` (vLLM). A list that
 *  carries none of them is unknown, never a guess. */
export const WINDOW_FIELDS = [
	"context_length",
	"context_window",
	"max_context_length",
	"max_model_len",
] as const;

/** Read the window out of one models-list entry, or null. */
export function windowFromEntry(entry: unknown): number | null {
	if (typeof entry !== "object" || entry === null) return null;
	for (const f of WINDOW_FIELDS) {
		const n = positive((entry as Record<string, unknown>)[f]);
		if (n) return n;
	}
	return null;
}

/** Exact id match only: a near miss must never lend another model's window. The
 *  body is untrusted: validate its shape, never cast it (same guard as
 *  packages/providers/index.ts). */
function windowFromList(json: unknown, model: string): number | null {
	const data = (json as { data?: unknown } | null)?.data;
	const list: unknown[] = Array.isArray(data) ? data : [];
	const entry = list.find(
		(m) => typeof m === "object" && m !== null && (m as { id?: unknown }).id === model,
	);
	return windowFromEntry(entry);
}

/** Providers whose window is the local server's answer, not a models list. */
const LOCAL_PROVIDERS = new Set(["ollama", "8gent", "llama-server"]);

/** OpenRouter's catalogue is public (no key sent). Any other hosted provider is
 *  asked at its own baseUrl, with the key the owner already set for it. */
async function fromProviderMetadata(o: ResolveContextWindowOptions, f: typeof fetch, t: number) {
	if (o.provider === "openrouter") {
		const json = await getJson(f, "https://openrouter.ai/api/v1/models", {}, t, o.signal);
		return windowFromList(json, o.model);
	}
	if (LOCAL_PROVIDERS.has(o.provider) || !o.baseUrl) return null;
	let url: string;
	try {
		const u = new URL(`${o.baseUrl.replace(/\/+$/, "")}/models`);
		if (u.protocol !== "https:" && u.protocol !== "http:") return null;
		url = u.toString();
	} catch {
		return null;
	}
	const json = await getJson(
		f,
		url,
		{ headers: o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {} },
		t,
		o.signal,
	);
	return windowFromList(json, o.model);
}

/** Providers served by the local Ollama. `8gent` is the out-of-box default
 *  and runs on the same Ollama host (packages/providers/index.ts). */
const OLLAMA_PROVIDERS = new Set(["ollama", "8gent"]);

/** What the running local server says: Ollama's loaded num_ctx (else the
 *  model's trained length), or llama-server's n_ctx. */
async function fromLocalServer(o: ResolveContextWindowOptions, f: typeof fetch, t: number) {
	if (OLLAMA_PROVIDERS.has(o.provider) && o.ollamaBaseUrl) {
		const json = (await getJson(
			f,
			`${o.ollamaBaseUrl.replace(/\/+$/, "")}/api/show`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: o.model }),
			},
			t,
			o.signal,
		)) as { parameters?: string; model_info?: Record<string, unknown> } | null;
		if (!json) return null;
		const numCtx = /^\s*num_ctx\s+(\d+)/m.exec(
			typeof json.parameters === "string" ? json.parameters : "",
		);
		const loaded = numCtx ? positive(Number(numCtx[1])) : null;
		if (loaded) return loaded;
		for (const [k, v] of Object.entries(json.model_info ?? {})) {
			if (k.endsWith(".context_length")) return positive(v);
		}
		return null;
	}
	if (o.provider === "llama-server" && o.llamaServerUrl) {
		const json = (await getJson(
			f,
			`${o.llamaServerUrl.replace(/\/+$/, "")}/props`,
			{},
			t,
			o.signal,
		)) as {
			default_generation_settings?: { n_ctx?: number };
		} | null;
		return positive(json?.default_generation_settings?.n_ctx);
	}
	return null;
}

const windowCache = new Map<string, ContextWindow>();
const cacheKey = (o: ResolveContextWindowOptions) =>
	`${o.provider}\u0000${o.baseUrl ?? ""}\u0000${o.model}`;

/** Test hook: forget what this session already learned. */
export function clearWindowCache(): void {
	windowCache.clear();
}

/** Resolved once per provider and model for the session. Only a real answer is
 *  kept: an unknown is asked again, so a key added later is picked up. */
export async function resolveContextWindowCached(
	o: ResolveContextWindowOptions,
): Promise<ContextWindow> {
	const key = cacheKey(o);
	const hit = windowCache.get(key);
	if (hit) return hit;
	const w = await resolveContextWindow(o);
	if (w.window !== null) windowCache.set(key, w);
	return w;
}

/** Never rejects: any failure, including a parser bug on a hostile body, is
 *  an unknown window, not a crashed TUI. */
export async function resolveContextWindow(o: ResolveContextWindowOptions): Promise<ContextWindow> {
	try {
		if (!o.model) return UNKNOWN_WINDOW;
		const f = o.fetchImpl ?? fetch;
		const t = o.timeoutMs ?? 4000;
		const fromProvider = await fromProviderMetadata(o, f, t);
		if (fromProvider) return { window: fromProvider, source: "provider" };
		const fromServer = await fromLocalServer(o, f, t);
		if (fromServer) return { window: fromServer, source: "server" };
		return UNKNOWN_WINDOW;
	} catch {
		return UNKNOWN_WINDOW;
	}
}

/**
 * Tokens in the window after a step: prompt plus completion of that one
 * request. Returns null for an event that measured nothing (the agent emits
 * synthetic all-zero step events); callers keep the previous reading.
 */
export function stepContextUsed(usage: {
	promptTokens: number;
	completionTokens: number;
	totalTokens?: number;
}): number | null {
	const used = (usage.promptTokens || 0) + (usage.completionTokens || 0);
	return used > 0 ? used : null;
}

export type ContextMeter =
	| { kind: "unknown"; used: number }
	| { kind: "fresh" }
	| { kind: "measured"; pct: number; source: Exclude<ContextWindowSource, "unknown"> };

/** The one value the HUD draws. Unknown window never produces a percent. */
export function contextMeter(used: number | null, w: ContextWindow): ContextMeter {
	if (w.window === null || w.source === "unknown") return { kind: "unknown", used: used ?? 0 };
	if (used === null) return { kind: "fresh" };
	return {
		kind: "measured",
		pct: Math.min(100, Math.round((used / w.window) * 100)),
		source: w.source,
	};
}
