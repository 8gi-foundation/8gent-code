import { getProviderManager } from "../../../../packages/providers/index.js";

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
export type AgentRuntime = "ollama" | "lmstudio" | "openrouter";

/**
 * Map a TUI provider id to the runtime literal the Agent understands.
 *
 * This is the single authority for provider -> runtime resolution. Every site
 * that builds a turn-serving Agent must route through it so the mappings cannot
 * drift (a stale ad-hoc `let runtime = "ollama"` block was the source of a
 * provider-routing bug where `--provider=lmstudio` ran against Ollama).
 *
 * - lmstudio                         -> lmstudio
 * - openrouter / openrouter-free     -> openrouter
 * - apfel (apple-foundation), ollama -> ollama (apfel rides the ollama adapter
 *   chain, matching prior behaviour)
 * - undefined / unknown              -> ollama (safe local default)
 */
export function providerToRuntime(provider?: string): AgentRuntime {
	if (provider === "lmstudio") return "lmstudio";
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
