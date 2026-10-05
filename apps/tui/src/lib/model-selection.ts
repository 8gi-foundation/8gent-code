import { getProviderManager, resolveModel } from "../../../../packages/providers/index.js";

/**
 * Pick a sensible default chat model from provider lists (avoid embedding / rerank models).
 */

/** Heuristic: model id is probably an embedding or rerank model, not for chat completions. */
export function isLikelyEmbeddingModelId(id: string): boolean {
	const s = id.toLowerCase();
	if (/\brerank\b/.test(s)) return true;
	if (/\btext-embedding\b/.test(s)) return true;
	if (/\bsentence-transformers\b/.test(s)) return true;
	if (
		/^nomic-embed|^bge-|^mxbai-embed|^jina-embed|^e5-|multilingual-e5|all-minilm|snowflake-arctic-embed/.test(
			s,
		)
	) {
		return true;
	}
	if (/\bembedding\b/.test(s)) return true;
	if (/\bembed\b/.test(s) && !/\bembedd?ed\b/.test(s)) return true;
	return false;
}

/**
 * What an Ollama model says it can do, from `/api/show` `capabilities`
 * (#3548), or null when it does not say (older Ollama, an error, a timeout).
 * Known answers are cached per host and model; a null answer is not, so a
 * host that was down is asked again next time.
 */
const capabilityCache = new Map<string, string[]>();

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

async function ollamaCapabilities(
	root: string,
	model: string,
	fetchImpl: FetchLike,
	timeoutMs: number,
): Promise<string[] | null> {
	const key = `${root}\n${model}`;
	const hit = capabilityCache.get(key);
	if (hit) return hit;
	try {
		const res = await fetchImpl(`${root}/api/show`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return null;
		const caps = ((await res.json()) as { capabilities?: unknown })?.capabilities;
		if (!Array.isArray(caps) || caps.length === 0) return null;
		const list = caps.map((c) => String(c));
		capabilityCache.set(key, list);
		return list;
	} catch {
		return null;
	}
}

/**
 * Ollama models that can chat (#3548). A model whose reported capabilities
 * lack "completion" (Ollama's decision models report only "decision"; embedding
 * models report "embedding") is dropped. A model that reports nothing falls
 * back to the name heuristic, which, as before, gives way when it would leave
 * no model at all.
 */
export async function filterChatCapable(
	root: string,
	ids: string[],
	opts?: { fetch?: FetchLike; timeoutMs?: number },
): Promise<string[]> {
	const fetchImpl = opts?.fetch ?? ((url, init) => fetch(url, init));
	const timeoutMs = opts?.timeoutMs ?? 2000;
	const caps = await Promise.all(ids.map((id) => ollamaCapabilities(root, id, fetchImpl, timeoutMs)));
	const capable = ids
		.map((id, i) => ({ id, caps: caps[i] }))
		.filter((m) => m.caps === null || m.caps.includes("completion"));
	const named = capable.filter((m) => m.caps !== null || !isLikelyEmbeddingModelId(m.id));
	return (named.length > 0 ? named : capable).map((m) => m.id);
}

function scoreChatModelCandidate(id: string): number {
	if (isLikelyEmbeddingModelId(id)) return -1e9;
	const s = id.toLowerCase();
	let score = 10;
	if (s.startsWith("eight")) score += 500;
	if (/\b(instruct|chat)\b/.test(s) || /(?:^|[-_/])(it|instruct)(?:$|[-_/])/i.test(id)) {
		score += 80;
	}
	const sizeMatch = s.match(/(\d{1,3})b\b/);
	if (sizeMatch) score += Math.min(Number.parseInt(sizeMatch[1], 10), 120);
	if (/\b(0\.5b|1b|2b|3b)\b/.test(s) && !/\b(30|32|70|72)\b/.test(s)) score -= 15;
	return score;
}

/**
 * Prefer a non-embedding model; optional `preference` does exact, substring, then fuzzy match.
 */
export function pickBestChatModel(modelIds: string[], opts?: { preference?: string }): string {
	if (modelIds.length === 0) return "";
	const unique = Array.from(new Set(modelIds.flatMap((x) => {
		const t = x.trim();
		return t ? [t] : [];
	})));
	const chatOnly = unique.filter((id) => !isLikelyEmbeddingModelId(id));
	const pool = chatOnly.length > 0 ? chatOnly : unique;

	const want = opts?.preference?.trim();
	if (want) {
		const lo = want.toLowerCase();
		const exact = pool.find((id) => id === want);
		if (exact) return exact;
		const exactLo = pool.find((id) => id.toLowerCase() === lo);
		if (exactLo) return exactLo;
		const sub = pool.find(
			(id) =>
				id.toLowerCase().includes(lo) ||
				lo.replace(/[-_:]/g, "").includes(id.toLowerCase().replace(/[-_:./]/g, "")),
		);
		if (sub) return sub;
		const norm = (s: string) => s.toLowerCase().replace(/[-_:./]/g, "");
		const nLo = norm(lo);
		const fuzzy = pool.find((id) => {
			const n = norm(id);
			return n.includes(nLo) || nLo.includes(n);
		});
		if (fuzzy) return fuzzy;
	}

	const scored = pool.map((id) => ({ id, score: scoreChatModelCandidate(id) }));
	scored.sort((a, b) => b.score - a.score);
	return scored[0]?.id || pool[0] || "";
}

/** Runtime literal understood by the Agent's AgentConfig. */
export type AgentRuntime = "ollama" | "lmstudio" | "llama-server" | "openrouter";

/**
 * Map a TUI provider id to the runtime literal the Agent understands.
 *
 * This is the single authority for provider -> runtime resolution. Every site
 * that builds a turn-serving Agent must route through it so the mappings cannot
 * drift (a stale ad-hoc `let runtime = "ollama"` block was the source of a
 * provider-routing bug where `--provider=lmstudio` ran against Ollama).
 *
 * - lmstudio                         -> lmstudio
 * - llama-server                     -> llama-server (#3149)
 * - openrouter / openrouter-free     -> openrouter
 * - apfel (apple-foundation), ollama -> ollama (apfel rides the ollama adapter
 *   chain, matching prior behaviour)
 * - undefined / unknown              -> ollama (safe local default)
 */
export function providerToRuntime(provider?: string): AgentRuntime {
	if (provider === "lmstudio") return "lmstudio";
	if (provider === "llama-server") return "llama-server";
	if (provider === "openrouter" || provider === "openrouter-free") return "openrouter";
	// apfel / apple-foundation, ollama, undefined, and any unknown provider fall
	// through to the ollama runtime (apfel is OpenAI-compatible and handled by the
	// Agent's own adapter chain).
	return "ollama";
}

/**
 * Map a CLI / saved provider string to a provider id, validated against the
 * LOADED provider registry (built-ins plus providers.json declarations), not a
 * second hand-kept list: that list silently dropped `--provider 8gent` and every
 * other registry provider it did not name (#3081). Only the TUI's own spellings
 * are handled here: `lm-studio` / `lm_studio` for lmstudio, and the TUI-only
 * `openrouter-free`. An unknown name returns undefined. `isKnown` is injectable
 * for tests; by default it asks the provider manager.
 */
export function normalizeProviderId(
	raw?: string,
	isKnown: (name: string) => boolean = (name) => getProviderManager().isKnownProvider(name),
): string | undefined {
	if (!raw?.trim()) return undefined;
	const x = raw.trim().toLowerCase().replace(/_/g, "-");
	const compact = x.replace(/-/g, "");
	if (compact === "lmstudio") return "lmstudio";
	if (compact === "openrouterfree") return "openrouter-free";
	if (isKnown(x)) return x;
	// A provider declared in providers.json keeps the case its author typed.
	const asTyped = raw.trim();
	if (asTyped !== x && isKnown(asTyped)) return asTyped;
	return undefined;
}

/** A provider/model pair as the foreground agent consumes it. */
export interface ModelSpec {
	provider: string;
	model: string;
}


/**
 * The model the validity check should switch to once a provider's model list
 * has loaded, or null to keep the current one.
 *
 * An explicit launch choice is never overridden (#3084): `--provider 8gent
 * --model qwen3.8:27b-mlx` loads the registry's DECLARED list for 8gent
 * (`eight-1.0-q3:14b`), the requested model is not on it, and the old check
 * swapped in the declared default. That model was not installed, so the agent
 * silently rerouted, the header showed a model that never ran, and the rebuilt
 * agent dropped the reply. A model the user named is the user's call; if it is
 * wrong the turn says so.
 */
export function autoSelectModel(opts: {
	current: string;
	currentProvider: string;
	available: string[];
	/** The launch --provider/--model pin, if the user passed one. */
	explicit: ModelSpec | null;
}): string | null {
	const { current, currentProvider, available, explicit } = opts;
	if (available.length === 0) return null;
	// "auto:free" is an alias, never a list entry: the OpenRouter list holds
	// real ids. Swapping it for the list's best pick ran a PAID model while
	// the user had asked for a free one (#3289). It is resolved to a real
	// ":free" id when the agent is built (resolveAgentModel).
	if (current === AUTO_FREE && providerToRuntime(currentProvider) === "openrouter") return null;
	if (explicit && current && explicit.model === current && explicit.provider === currentProvider) return null;
	const inList = Boolean(current && available.includes(current));
	if (current && inList && !isLikelyEmbeddingModelId(current)) return null;
	const next = pickBestChatModel(available, { preference: explicit?.model || undefined });
	return next && next !== current ? next : null;
}

/** The OpenRouter alias for "the best free model right now". */
export const AUTO_FREE = "auto:free";

/**
 * The model id an agent is actually built with. `auto:free` on OpenRouter
 * becomes a real free id from the live list (#3289): the TUI's OpenRouter
 * client would otherwise send the literal alias. It never falls back to a
 * paid id: if no free id can be found the result says why, and the caller
 * shows that instead of running.
 */
export async function resolveAgentModel(
	provider: string,
	model: string,
	resolve: (m: string) => Promise<{ model: string }> = (m) => resolveModel(m, { strict: true }),
): Promise<{ ok: true; model: string } | { ok: false; reason: string }> {
	if (model !== AUTO_FREE || providerToRuntime(provider) !== "openrouter")
		return { ok: true, model };
	try {
		const { model: id } = await resolve(model);
		if (!id.endsWith(":free"))
			return { ok: false, reason: `the best match, ${id}, is not a free model` };
		return { ok: true, model: id };
	} catch (err) {
		return { ok: false, reason: (err as Error)?.message || "no free model could be found" };
	}
}

/** What the agent-init step does with the active spec (#3289). */
export type AgentBuildPlan = { kind: "build"; model: string } | { kind: "wait"; notice: string };

/**
 * Spec in, the model to build the agent with or a notice-and-retry out. The
 * TUI builds its agent from `plan.model`, never from the raw spec: for
 * `auto:free` the spec is an alias, and the only safe id is a live ":free"
 * one. When none can be found the tab shows `notice` and retries; nothing
 * runs, and nothing paid is substituted.
 */
export async function planAgentBuild(
	provider: string,
	model: string,
	resolve?: (m: string) => Promise<{ model: string }>,
): Promise<AgentBuildPlan> {
	const r = await resolveAgentModel(provider, model, resolve);
	if (r.ok) return { kind: "build", model: r.model };
	return {
		kind: "wait",
		notice: `No free OpenRouter model to run: ${r.reason}. Nothing will run until one is found. Pick a model with /model, or another provider with /provider.`,
	};
}

/**
 * Whether a tab's existing agent can keep serving the active spec. Compare the
 * spec the agent was BUILT for, not its live config: the agent self-corrects
 * `config.model` after a reroute, and comparing the live value made the TUI
 * drop and rebuild the agent the moment the rerouted turn finished, which
 * discarded that turn's in-flight reply ("No reply.", #3084).
 */
export function canReuseTabAgent(built: { model?: string; runtime?: string }, want: { model: string; runtime: string }): boolean {
	return built.model === want.model && built.runtime === want.runtime;
}

/**
 * The agent role a chat tab's data carries ("orchestrator", "engineer",
 * "qa"), or undefined for a tab without one. It decides the local tool set:
 * only the Orchestrator registers the delegation tools (#3095).
 */
export function tabAgentRole(data: unknown): "orchestrator" | "engineer" | "qa" | undefined {
	const role = (data as { role?: unknown } | null | undefined)?.role;
	return role === "orchestrator" || role === "engineer" || role === "qa" ? role : undefined;
}

/** The tab a CLI --provider/--model override was pinned to at launch, with that spec. */
export interface CliTabPin {
	tabId: string;
	spec: ModelSpec;
}

/**
 * What the foreground provider/model must become when a chat tab is activated.
 *
 * - The tab the CLI override was pinned to gets the launch spec back. Doing
 *   nothing here is the bug: the foreground state still holds the previous
 *   tab's model, so returning to Orchestrator after QA ran QA's model.
 * - Any other tab gets its role spec (settings override -> role registry).
 * - null means leave the current provider/model alone (no role spec known).
 */
export function specForActivatedTab(
	tabId: string,
	pin: CliTabPin | null,
	roleSpec: ModelSpec | null,
): ModelSpec | null {
	if (pin && pin.tabId === tabId) return pin.spec;
	return roleSpec;
}

/** The one registry call `declaredModels` needs (ProviderManager in packages/providers). */
export interface ProviderModelsReader {
	isKnownProvider(name: string): boolean;
	getProvider(name: string): { models?: readonly string[] };
}

/**
 * Models a provider's registry entry declares, for providers the TUI has no
 * live model listing for (8gent, groq, openai and the rest). Empty for a name
 * the registry does not know. Never an invented `${provider}/default` id: that
 * placeholder used to replace the configured model, so the footer, the chat
 * header and the rail all named a model that does not exist.
 */
export function declaredModels(reader: ProviderModelsReader, provider: string): string[] {
	if (!provider || !reader.isKnownProvider(provider)) return [];
	try {
		const models = reader.getProvider(provider).models ?? [];
		return models.map((m) => String(m).trim()).filter((m) => m.length > 0);
	} catch {
		return [];
	}
}

/**
 * Whether the TUI should list a provider's models from the configured Ollama's
 * installed models rather than from the registry (#3332). The `8gent` provider
 * is Ollama at the same host (providerToRuntime maps it to "ollama"), so its
 * declared list (`eight-1.0-q3:14b`, not installed on most machines) hid a
 * missing default: the session kept it and every turn missed in Ollama, then
 * went to OpenRouter with an id OpenRouter does not serve. With the installed
 * list, autoSelectModel swaps the missing model once, before the first turn.
 */
export function listsInstalledOllamaModels(provider: string): boolean {
	return provider === "ollama" || provider === "8gent";
}

/**
 * The one-line notice for when autoSelectModel replaced a model Ollama does
 * not have (#3332), or null when there is nothing to tell: a first pick (no
 * previous model), a provider not backed by Ollama, or a model that is
 * installed (an embedding-model swap is not a missing model).
 */
export function missingModelNotice(opts: {
	provider: string;
	from: string;
	to: string;
	available: string[];
}): string | null {
	const { provider, from, to, available } = opts;
	if (!from || !to || from === to) return null;
	if (!listsInstalledOllamaModels(provider)) return null;
	if (available.includes(from)) return null;
	return `${from} is not installed in Ollama, so this session uses ${to}. Pick another with /model.`;
}
