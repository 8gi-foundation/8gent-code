/**
 * Provider readiness gate for agent initialisation.
 *
 * The fault this exists for (2026-09-28): LM Studio's port accepted TCP but
 * never answered HTTP. The agent init awaited an unbounded `/v1/models` fetch,
 * so the tab's agent never became ready - no error, no timeout, no fallback -
 * while Ollama sat healthy on the same machine.
 *
 * Rules enforced here:
 *  - Every probe is bounded (default 3s). A socket that accepts and never
 *    answers is DOWN, not "still starting".
 *  - If the configured local provider is down, fall back along the TUI's
 *    local detection order (LM Studio -> Ollama) to the next healthy one and
 *    say so in one line.
 *  - If no local provider is healthy, return a clear error with next steps.
 *  - Non-local providers (OpenRouter and friends) are not probed here.
 */

import { resolveOllamaBaseUrl } from "../../../../packages/ai/text-tool-endpoint.js";
import { createLlamaServer, isLlamaServerSelected, resolveLlamaServerUrl } from "../../../../packages/local-model-server/index.js";
import { pickBestChatModel } from "./model-selection.js";

export const PROBE_TIMEOUT_MS = 3000;

export interface LocalProviderEndpoint {
	provider: string;
	label: string;
	modelsUrl: string;
	extract: (data: any) => string[];
}

/** Same order as `detectBestLocalProvider()` in app.tsx: LM Studio, then Ollama. */
export function localProviderEndpoints(
	env: Record<string, string | undefined> = process.env,
): LocalProviderEndpoint[] {
	const lm = (env.LM_STUDIO_HOST || "http://localhost:1234").replace(/\/+$/, "");
	// The same resolution as the rest of the app (#3115): OLLAMA_BASE_URL, then
	// OLLAMA_HOST, normalised. A bare "host:port" OLLAMA_HOST (what the ollama
	// CLI accepts) used to become an invalid URL here and read as unreachable.
	const openAiIds: LocalProviderEndpoint["extract"] = (d) => (d?.data || []).map((m: any) => String(m?.id ?? ""));
	const lmStudio: LocalProviderEndpoint = { provider: "lmstudio", label: "LM Studio", modelsUrl: `${lm}/v1/models`, extract: openAiIds };
	// With llama-server selected (#3149) Ollama is off and is never probed.
	if (isLlamaServerSelected(env)) {
		const llama = createLlamaServer({ baseUrl: resolveLlamaServerUrl(env) });
		return [{ provider: "llama-server", label: "llama-server", modelsUrl: llama.modelsUrl, extract: openAiIds }, lmStudio];
	}
	const ollama = resolveOllamaBaseUrl(env);
	return [
		lmStudio,
		{
			provider: "ollama",
			label: "Ollama",
			modelsUrl: `${ollama}/api/tags`,
			extract: (d) => (d?.models || []).map((m: any) => String(m?.name ?? "")),
		},
	];
}

export type ProbeResult = { ok: true; models: string[] } | { ok: false; reason: string };

/** Fetch a provider's model list within `timeoutMs`. Never throws, never hangs. */
export async function probeModels(
	url: string,
	extract: (data: any) => string[],
	timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return { ok: false, reason: `http ${res.status}` };
		const models = extract(await res.json()).flatMap((s) => {
			const t = s.trim();
			return t ? [t] : [];
		});
		return { ok: true, models };
	} catch (err) {
		const name = (err as Error)?.name;
		if (name === "TimeoutError" || name === "AbortError") {
			return { ok: false, reason: `no answer within ${timeoutMs / 1000}s` };
		}
		return { ok: false, reason: "not reachable" };
	}
}

export type ReadinessDecision =
	| { kind: "ready"; provider: string; model: string }
	| {
			kind: "fallback";
			provider: string;
			model: string;
			from: string;
			reason: string;
			notice: string;
	  }
	| {
			kind: "none";
			from: string;
			/** host:port the configured provider was probed at, for the no-model card (T5). */
			fromAddress: string;
			reason: string;
			notice: string;
	  };

/** Reason used when an engine answers but lists no models (T5). */
export const NO_MODELS_REASON = "no models";

/**
 * Decide which provider/model the agent should be built on. Bounded: at most
 * one probe per local provider, each capped at `timeoutMs`.
 */
export async function resolveReadyProvider(
	want: { provider: string; model: string; pinned?: boolean },
	opts: { timeoutMs?: number; endpoints?: LocalProviderEndpoint[] } = {},
): Promise<ReadinessDecision> {
	const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
	const endpoints = opts.endpoints ?? localProviderEndpoints();
	const configured = endpoints.find((e) => e.provider === want.provider);
	if (!configured) return { kind: "ready", provider: want.provider, model: want.model };

	const own = await probeModels(configured.modelsUrl, configured.extract, timeoutMs);
	// An engine that answers with an empty model list cannot serve a turn
	// either (T5): a fresh Ollama before `ollama pull` looks exactly like this.
	if (own.ok && own.models.length > 0)
		return { kind: "ready", provider: want.provider, model: want.model };

	const reason = own.ok ? NO_MODELS_REASON : own.reason;
	const what = reason === NO_MODELS_REASON ? "has no models" : `is unreachable (${reason})`;
	// A provider named with --provider is never swapped for another (#3746).
	if (want.pinned) {
		return {
			kind: "none",
			from: configured.provider,
			fromAddress: addressOf(configured.modelsUrl),
			reason,
			notice:
				`${configured.label} ${what}. It was chosen with --provider, so no other provider is used. ` +
				`Start ${configured.label}, or pick another provider with /provider.`,
		};
	}
	for (const alt of endpoints) {
		if (alt.provider === configured.provider) continue;
		const r = await probeModels(alt.modelsUrl, alt.extract, timeoutMs);
		if (!r.ok) continue;
		const model = pickBestChatModel(r.models);
		if (!model) continue;
		return {
			kind: "fallback",
			provider: alt.provider,
			model,
			from: configured.provider,
			reason,
			notice: `${configured.label} ${what}. Using ${alt.label} (${model}) for this session. /provider to change.`,
		};
	}
	return {
		kind: "none",
		from: configured.provider,
		fromAddress: addressOf(configured.modelsUrl),
		reason,
		notice:
			`${configured.label} ${what} and no other local provider answered. ` +
			"Nothing will run until one does. Start LM Studio or Ollama, or pick another provider with /provider.",
	};
}

/** "http://127.0.0.1:11434/api/tags" -> "127.0.0.1:11434". */
export function addressOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/**
 * How long the TUI waits before retrying agent init after it ended not ready,
 * so a provider started after launch is picked up. Equal to the readiness
 * cache TTL, so each retry probes afresh.
 */
export const READINESS_RETRY_MS = 10_000;

/**
 * Share one probe per provider/model across callers for `ttlMs`.
 *
 * The TUI's agent-init effect can re-run several times while the app settles
 * (provider, model and tab resolve one after another), cancelling the previous
 * run each time. Without sharing, every run starts its own 3s probe and is
 * cancelled before it finishes, so no run ever acts on a result. With sharing,
 * every run awaits the same probe and the run that is current when it lands
 * acts on it. The TTL lets a provider that comes back be noticed again on the
 * next retry (READINESS_RETRY_MS).
 */
export function createReadinessCache(
	ttlMs = READINESS_RETRY_MS,
	resolve: typeof resolveReadyProvider = resolveReadyProvider,
	now: () => number = Date.now,
): (want: { provider: string; model: string; pinned?: boolean }) => Promise<ReadinessDecision> {
	const entries = new Map<string, { at: number; done: boolean; p: Promise<ReadinessDecision> }>();
	return (want) => {
		const key = `${want.provider}\u0000${want.model}\u0000${want.pinned ? "pinned" : ""}`;
		const hit = entries.get(key);
		if (hit && (!hit.done || now() - hit.at < ttlMs)) return hit.p;
		const entry = { at: now(), done: false, p: resolve(want) };
		entry.p = entry.p.finally(() => {
			entry.done = true;
			entry.at = now();
		});
		entries.set(key, entry);
		return entry.p;
	};
}

/** Resolve `p`, or `fallback` after `ms`. Keeps agent init from waiting forever. */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(fallback), ms);
	});
	return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}
