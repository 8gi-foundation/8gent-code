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
	openRouterKey?: string;
	timeoutMs?: number;
}

export const UNKNOWN_WINDOW: ContextWindow = { window: null, source: "unknown" };

const positive = (n: unknown): number | null =>
	typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;

async function getJson(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<unknown> {
	try {
		const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
		return res.ok ? await res.json() : null;
	} catch {
		return null;
	}
}

/** OpenRouter lists `context_length` per model. Exact id match only: a near
 *  miss must never lend another model's window. */
async function fromProviderMetadata(o: ResolveContextWindowOptions, f: typeof fetch, t: number) {
	if (o.provider !== "openrouter") return null;
	const json = (await getJson(
		f,
		"https://openrouter.ai/api/v1/models",
		{ headers: o.openRouterKey ? { Authorization: `Bearer ${o.openRouterKey}` } : {} },
		t,
	)) as { data?: { id?: string; context_length?: number }[] } | null;
	const entry = json?.data?.find((m) => m.id === o.model);
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
		)) as { parameters?: string; model_info?: Record<string, unknown> } | null;
		if (!json) return null;
		const numCtx = /^\s*num_ctx\s+(\d+)/m.exec(json.parameters ?? "");
		if (numCtx) return positive(Number(numCtx[1]));
		for (const [k, v] of Object.entries(json.model_info ?? {})) {
			if (k.endsWith(".context_length")) return positive(v);
		}
		return null;
	}
	if (o.provider === "llama-server" && o.llamaServerUrl) {
		const json = (await getJson(f, `${o.llamaServerUrl.replace(/\/+$/, "")}/props`, {}, t)) as {
			default_generation_settings?: { n_ctx?: number };
		} | null;
		return positive(json?.default_generation_settings?.n_ctx);
	}
	return null;
}

export async function resolveContextWindow(o: ResolveContextWindowOptions): Promise<ContextWindow> {
	if (!o.model) return UNKNOWN_WINDOW;
	const f = o.fetchImpl ?? fetch;
	const t = o.timeoutMs ?? 4000;
	const fromProvider = await fromProviderMetadata(o, f, t);
	if (fromProvider) return { window: fromProvider, source: "provider" };
	const fromServer = await fromLocalServer(o, f, t);
	if (fromServer) return { window: fromServer, source: "server" };
	return UNKNOWN_WINDOW;
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
