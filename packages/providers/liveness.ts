/**
 * 8gent Code - Provider liveness probes
 *
 * Routing may not trust advertised capability. Every field a provider hands us
 * about itself has been observed lying on a real machine:
 *
 *   ollama qwen3.8:27b-mlx  capabilities:["tools"]     hangs forever on a tools
 *                                                      payload (#2894)
 *   apfel /v1/models        lists apple-foundationmodel  completion -> HTTP 500
 *                           with supported_parameters    "Apple Intelligence is
 *                           including "tools"            not enabled."
 *   settings defaults       apfel baseURL :11500       nothing listens there
 *   settings defaults       apfel baseURL :11434       that is OLLAMA's port, so
 *   (historic)                                         Ollama silently answered
 *                                                      as apfel. See
 *                                                      __tests__/keyless-local.test.ts
 *   ProviderConfig.enabled  "provider is available"    a config flag, set by a
 *                                                      human, proving nothing
 *
 * So this module earns the right to route by sending a real one-token
 * completion and timing it. Nothing here reads `supportsTools`, `enabled`, or
 * any /v1/models listing. A provider is routable only if it recently answered.
 *
 * Deliberately dependency-free (global fetch + AbortSignal) and side-effect
 * free at import: it can be called from the daemon, the TUI, or a test without
 * pulling in the provider manager.
 */

/**
 * Why the completion failed. These are kept distinct because they demand
 * different responses and all three occurred on one machine in one day.
 *
 *   unreachable - connection refused / DNS failure. Nothing is listening.
 *                 Cheap to retry; the port is simply wrong or the service is
 *                 down. Observed: :11500, refused in ~1ms.
 *   http_error  - the service answered, and answered "no". A real, fast, honest
 *                 failure that will persist until a human changes something.
 *                 Observed: apfel HTTP 500 in ~348ms, Apple Intelligence off.
 *   timeout     - the worst one. The socket stays open and nothing comes back.
 *                 This is what burns James's 120 seconds, and it is the reason
 *                 this module exists. Must get the longest backoff, because
 *                 each retry costs a full timeout window.
 *   empty       - HTTP 200, well-formed envelope, no content. The provider
 *                 claims success and delivers nothing, which a naive
 *                 `res.ok` check scores as a pass.
 */
export type ProbeOutcome = "alive" | "unreachable" | "http_error" | "timeout" | "empty";

export interface ProbeTarget {
	/** Provider name, e.g. "apfel". Used only as a label and cache key. */
	provider: string;
	/** Model id to send. The probe verifies THIS model, not the provider. */
	model: string;
	/** OpenAI-compatible base URL, with or without a trailing /v1. */
	baseUrl: string;
	/** Optional bearer token. Local providers are keyless and omit it. */
	apiKey?: string;
}

export interface ProbeResult extends ProbeTarget {
	outcome: ProbeOutcome;
	/** Measured wall-clock ms. Real, always - never estimated or defaulted. */
	latencyMs: number;
	/**
	 * True only when a payload carrying a real tool definition came back
	 * within the timeout. Undefined means "not probed for tools", which is NOT
	 * the same as false and must never be treated as tool-capable.
	 */
	toolsOk?: boolean;
	/** Short human-readable cause. Empty on success. */
	detail: string;
	ts: number;
}

/** A probe that has not run is not a pass. */
export function isAlive(r: ProbeResult | undefined): r is ProbeResult {
	return r?.outcome === "alive";
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TOOLS_TIMEOUT_MS = 12_000;

function chatUrl(baseUrl: string): string {
	const b = baseUrl.replace(/\/+$/, "");
	return b.endsWith("/v1") ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
}

/**
 * The tool definition sent by the tools probe. Trivial on purpose: we are not
 * testing whether the model chooses well, only whether a tools payload comes
 * back at all. qwen3.8:27b-mlx never returns from this one.
 */
const PROBE_TOOL = {
	type: "function",
	function: {
		name: "probe_ack",
		description: "Acknowledge the probe.",
		parameters: {
			type: "object",
			properties: { ok: { type: "boolean" } },
			required: ["ok"],
		},
	},
} as const;

async function send(
	target: ProbeTarget,
	body: Record<string, unknown>,
	timeoutMs: number,
): Promise<ProbeResult> {
	const started = Date.now();
	const base: Omit<ProbeResult, "outcome" | "latencyMs" | "detail"> = { ...target, ts: started };
	const finish = (outcome: ProbeOutcome, detail: string): ProbeResult => ({
		...base,
		outcome,
		latencyMs: Date.now() - started,
		detail,
		ts: Date.now(),
	});

	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;

	let res: Response;
	try {
		res = await fetch(chatUrl(target.baseUrl), {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		const e = err as { name?: string; message?: string };
		// AbortSignal.timeout rejects with TimeoutError. Anything else at this
		// layer is a transport failure: refused, DNS, TLS.
		if (e?.name === "TimeoutError" || e?.name === "AbortError") {
			return finish("timeout", `no response within ${timeoutMs}ms`);
		}
		return finish("unreachable", e?.message ?? "transport failure");
	}

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		return finish("http_error", `HTTP ${res.status} ${text.slice(0, 160).replace(/\s+/g, " ")}`);
	}

	// A 200 is not a pass. Read the body and require actual content, because a
	// well-formed empty completion is a real observed failure mode.
	let json: unknown;
	try {
		json = await res.json();
	} catch {
		return finish("empty", "HTTP 200 with unparseable body");
	}
	const choice = (json as { choices?: Array<Record<string, unknown>> })?.choices?.[0];
	if (!choice) return finish("empty", "HTTP 200 with no choices");
	const msg = (choice.message ?? {}) as { content?: unknown; tool_calls?: unknown };
	const hasText = typeof msg.content === "string" && msg.content.trim().length > 0;
	const hasToolCall = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
	// max_tokens:1 can legitimately truncate to empty content, so a finish_reason
	// of "length" still counts as the engine having produced tokens.
	const produced = hasText || hasToolCall || choice.finish_reason === "length";
	if (!produced) return finish("empty", "HTTP 200 with empty completion");

	return finish("alive", "");
}

/**
 * Send a real one-token completion. This is the only evidence that earns a
 * route. Measured latency is recorded so a caller can apply its own budget:
 * a provider that answers in 25s is alive, but must not serve quick answers.
 */
export function probeCompletion(target: ProbeTarget, timeoutMs = DEFAULT_TIMEOUT_MS) {
	return send(
		target,
		{
			model: target.model,
			messages: [{ role: "user", content: "ok" }],
			max_tokens: 1,
			stream: false,
		},
		timeoutMs,
	);
}

/**
 * Send a real tools payload. Separate from the text probe because #2894 is
 * precisely a model that passes the text probe and hangs on this one - the
 * text result tells you nothing about tool capability.
 */
export async function probeTools(
	target: ProbeTarget,
	timeoutMs = DEFAULT_TOOLS_TIMEOUT_MS,
): Promise<ProbeResult> {
	const r = await send(
		target,
		{
			model: target.model,
			messages: [{ role: "user", content: "Call probe_ack with ok=true." }],
			tools: [PROBE_TOOL],
			max_tokens: 16,
			stream: false,
		},
		timeoutMs,
	);
	return { ...r, toolsOk: r.outcome === "alive" };
}

// ============================================
// Registry
// ============================================

export interface LivenessOptions {
	/** A result older than this is stale and does not authorise a route. */
	maxAgeMs?: number;
	timeoutMs?: number;
	toolsTimeoutMs?: number;
	/** Injected for tests. Defaults to the real network probes. */
	probe?: (t: ProbeTarget, timeoutMs: number) => Promise<ProbeResult>;
	toolsProbe?: (t: ProbeTarget, timeoutMs: number) => Promise<ProbeResult>;
	now?: () => number;
}

const BASE_BACKOFF_MS = 15_000;
/**
 * A timeout costs a full window every time it is retried, so it backs off
 * harder than a fast failure. Re-probing a hung Ollama at the same cadence as
 * a refused port would spend minutes per minute.
 */
const BACKOFF_MULTIPLIER: Record<ProbeOutcome, number> = {
	alive: 0,
	unreachable: 1,
	http_error: 2,
	empty: 2,
	timeout: 8,
};

function key(t: ProbeTarget): string {
	return `${t.provider}::${t.model}`;
}

/**
 * Caches probe results and answers the only question routing may ask:
 * "has this target recently proven it can answer?"
 */
export class LivenessRegistry {
	private results = new Map<string, ProbeResult>();
	private failures = new Map<string, number>();
	private inflight = new Map<string, Promise<ProbeResult>>();
	private readonly o: Required<Omit<LivenessOptions, "probe" | "toolsProbe" | "now">> &
		Pick<Required<LivenessOptions>, "probe" | "toolsProbe" | "now">;

	constructor(options: LivenessOptions = {}) {
		this.o = {
			maxAgeMs: options.maxAgeMs ?? 60_000,
			timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			toolsTimeoutMs: options.toolsTimeoutMs ?? DEFAULT_TOOLS_TIMEOUT_MS,
			probe: options.probe ?? probeCompletion,
			toolsProbe: options.toolsProbe ?? probeTools,
			now: options.now ?? Date.now,
		};
	}

	/** Last result for a target, or undefined if never probed. */
	get(target: ProbeTarget): ProbeResult | undefined {
		return this.results.get(key(target));
	}

	private fresh(r: ProbeResult | undefined): boolean {
		return !!r && this.o.now() - r.ts <= this.o.maxAgeMs;
	}

	/** True when a failing target is still inside its backoff window. */
	private cooling(r: ProbeResult | undefined): boolean {
		if (!r || r.outcome === "alive") return false;
		const n = this.failures.get(key(r)) ?? 1;
		const wait = BASE_BACKOFF_MS * BACKOFF_MULTIPLIER[r.outcome] * Math.min(n, 4);
		return this.o.now() - r.ts < wait;
	}

	private record(k: string, r: ProbeResult): ProbeResult {
		this.results.set(k, r);
		if (r.outcome === "alive") this.failures.delete(k);
		else this.failures.set(k, (this.failures.get(k) ?? 0) + 1);
		return r;
	}

	/**
	 * Probe unless a fresh result already exists or the target is cooling off
	 * after a failure. Concurrent calls for the same target share one request.
	 */
	async check(target: ProbeTarget, opts: { tools?: boolean; force?: boolean } = {}) {
		const k = key(target);
		const cached = this.results.get(k);
		if (!opts.force) {
			// A cached tools result satisfies a text query, but never the reverse:
			// passing text says nothing about tools. That is #2894 exactly.
			const covers = !opts.tools || cached?.toolsOk !== undefined;
			if (covers && (this.fresh(cached) || this.cooling(cached))) return cached as ProbeResult;
		}
		const existing = this.inflight.get(k);
		if (existing) return existing;

		const run = (
			opts.tools
				? this.o.toolsProbe(target, this.o.toolsTimeoutMs)
				: this.o.probe(target, this.o.timeoutMs)
		)
			.then((r) => this.record(k, r))
			.finally(() => this.inflight.delete(k));
		this.inflight.set(k, run);
		return run;
	}

	/**
	 * The routing gate. Refuses anything that has not passed a recent probe -
	 * including anything never probed at all, which is why the default is
	 * closed rather than open.
	 */
	isRoutable(target: ProbeTarget, opts: { tools?: boolean; maxLatencyMs?: number } = {}): boolean {
		const r = this.results.get(key(target));
		if (!isAlive(r) || !this.fresh(r)) return false;
		// Tool routing excludes anything not PROVEN tool-capable. `undefined`
		// (never probed for tools) fails here by construction, so a model can
		// never reach a tools payload on the strength of its own metadata.
		if (opts.tools && r.toolsOk !== true) return false;
		if (opts.maxLatencyMs !== undefined && r.latencyMs > opts.maxLatencyMs) return false;
		return true;
	}

	/**
	 * Probe candidates in order and return the first that qualifies. Order is
	 * the caller's preference; the probe only ever vetoes.
	 */
	async pick(
		candidates: readonly ProbeTarget[],
		opts: { tools?: boolean; maxLatencyMs?: number } = {},
	): Promise<ProbeResult | null> {
		for (const c of candidates) {
			await this.check(c, { tools: opts.tools });
			if (this.isRoutable(c, opts)) return this.results.get(key(c)) as ProbeResult;
		}
		return null;
	}

	/** Every recorded result, newest first. For /doctor and the status pane. */
	snapshot(): ProbeResult[] {
		return [...this.results.values()].sort((a, b) => b.ts - a.ts);
	}
}
