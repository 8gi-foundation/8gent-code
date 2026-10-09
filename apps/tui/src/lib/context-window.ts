/**
 * Context window for the model that ran the turn (#3321).
 *
 * The HUD bar used to divide by a constant 128000. This resolves the real
 * window instead: provider metadata first, then what the local server
 * reports, else an explicit "unknown". It never invents a number: unknown is
 * a state the bar shows as such.
 */

export type ContextWindowSource = "provider" | "server" | "unknown";

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
	timeoutMs?: number;
	/** Aborts in-flight requests, e.g. when the model changes or the HUD unmounts. */
	signal?: AbortSignal;
}

export const UNKNOWN_WINDOW: ContextWindow = { window: null, source: "unknown" };

/** Above any shipping model (10M tokens) with headroom. A larger value is
 *  junk from the wire, not a reading, so it falls to unknown. */
export const MAX_PLAUSIBLE_WINDOW = 100_000_000;

const positive = (n: unknown): number | null =>
	typeof n === "number" && Number.isFinite(n) && n >= 1 && n <= MAX_PLAUSIBLE_WINDOW ? Math.floor(n) : null;

async function getJson(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<unknown> {
	try {
		const timeout = AbortSignal.timeout(timeoutMs);
		const res = await fetchImpl(url, { ...init, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
		if (!res.ok) return null;
		// Hardening (8SO): refuse oversized bodies (1 MiB cap on a declared length).
		const declared = Number(res.headers?.get?.("content-length") ?? 0);
		if (declared > 1_048_576) return null;
		return await res.json();
	} catch {
		return null;
	}
}

/** OpenRouter lists `context_length` per model. Exact id match only: a near
 *  miss must never lend another model's window. The catalogue is public, so
 *  no key is sent. The body is untrusted: validate its shape, never cast it
 *  (same guard as packages/providers/index.ts). */
async function fromProviderMetadata(o: ResolveContextWindowOptions, f: typeof fetch, t: number) {
	if (o.provider !== "openrouter") return null;
	const json = (await getJson(f, "https://openrouter.ai/api/v1/models", {}, t, o.signal)) as {
		data?: unknown;
	} | null;
	const list: unknown[] = Array.isArray(json?.data) ? json.data : [];
	const entry = list.find(
		(m): m is { id: string; context_length?: unknown } =>
			typeof m === "object" && m !== null && typeof (m as { id?: unknown }).id === "string" &&
			(m as { id: string }).id === o.model,
	);
	return positive(entry?.context_length);
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
		const numCtx = /^\s*num_ctx\s+(\d+)/m.exec(typeof json.parameters === "string" ? json.parameters : "");
		const loaded = numCtx ? positive(Number(numCtx[1])) : null;
		if (loaded) return loaded;
		for (const [k, v] of Object.entries(json.model_info ?? {})) {
			if (k.endsWith(".context_length")) return positive(v);
		}
		return null;
	}
	if (o.provider === "llama-server" && o.llamaServerUrl) {
		const json = (await getJson(f, `${o.llamaServerUrl.replace(/\/+$/, "")}/props`, {}, t, o.signal)) as {
			default_generation_settings?: { n_ctx?: number };
		} | null;
		return positive(json?.default_generation_settings?.n_ctx);
	}
	return null;
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
