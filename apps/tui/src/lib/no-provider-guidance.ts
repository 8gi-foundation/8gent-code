/**
 * First run with no model (T5): when nothing can answer, say how to connect one.
 *
 * A bare machine (no Ollama, no LM Studio, no keys) used to open to "READY"
 * with "providers 0/3" in the status bar and nothing else. This decides when
 * the chat area shows the short "no model" card and what the card says.
 *
 * The card shows when the ACTIVE provider cannot run a turn:
 *  - a local engine provider (Ollama, LM Studio, llama-server, apfel) and no
 *    local engine answers the status-bar probe, or
 *  - a hosted provider that needs a key and has none.
 * It also shows whenever agent init reports the local provider unreachable,
 * and carries that reason. It never shows before the first probe has landed, so it does not flash on a
 * machine where Ollama is up, and never for providers that need neither
 * (host CLI sessions, providers declared in providers.json).
 */

import { getProviderManager } from "../../../../packages/providers/index.js";

/** Providers served by the local engines the status bar counts. "" = not chosen yet. */
export const LOCAL_ENGINE_PROVIDERS: ReadonlySet<string> = new Set([
	"",
	"8gent",
	"ollama",
	"lmstudio",
	"llama-server",
	"apfel",
	"apple-foundation",
]);

export type KeyStatus = "not-needed" | "present" | "missing";

export interface GuidanceInput {
	/** True once the status-bar probe has answered at least once. */
	checked: boolean;
	/** Local engines answering right now (the "providers X/Y" figure). */
	liveLocal: number;
	/** The active tab's provider id. */
	provider: string;
	/** Whether the active provider needs a key, and whether it has one. */
	keyStatus: KeyStatus;
	/**
	 * Agent init's reason when the configured local provider and its
	 * fallbacks all failed, e.g. "Ollama is not reachable.".
	 * Shown as the card's reason line; it alone is enough to show the card.
	 */
	unreachable?: string | null;
}

export function needsProviderGuidance(input: GuidanceInput): boolean {
	if (input.unreachable) return true;
	if (!input.checked) return false;
	if (LOCAL_ENGINE_PROVIDERS.has(input.provider)) return input.liveLocal === 0;
	return input.keyStatus === "missing";
}

/**
 * Does `provider` need an API key, and is one set (env or saved)? The TUI-only
 * "openrouter-free" spelling uses the OpenRouter key. Never throws.
 */
export function providerKeyStatus(
	provider: string,
	lookup: (name: string) => { needsKey: boolean; hasKey: boolean } = registryLookup,
): KeyStatus {
	const name = provider === "openrouter-free" ? "openrouter" : provider;
	if (LOCAL_ENGINE_PROVIDERS.has(name)) return "not-needed";
	try {
		const { needsKey, hasKey } = lookup(name);
		if (!needsKey) return "not-needed";
		return hasKey ? "present" : "missing";
	} catch {
		return "not-needed";
	}
}

function registryLookup(name: string): { needsKey: boolean; hasKey: boolean } {
	const pm = getProviderManager();
	if (!pm.isKnownProvider(name)) return { needsKey: false, hasKey: false };
	const config = pm.getProvider(name);
	return { needsKey: Boolean(config.apiKeyEnv), hasKey: Boolean(pm.getApiKey(name)) };
}

/**
 * The card's reason line from agent init's readiness result. "Ollama is
 * unreachable (not reachable)" said the same thing twice, so the plain case
 * reads "Ollama is not reachable." and the others keep their detail.
 */
export function unreachableLine(label: string, reason: string): string {
	if (reason === "not reachable") return `${label} is not reachable.`;
	return `${label} did not answer (${reason}).`;
}

export interface GuidancePath {
	/** The path's number, shown as text so the order never rests on colour. */
	n: string;
	title: string;
	/** Lines to type or do, in order. */
	steps: string[];
}

export interface GuidanceCopy {
	label: string;
	lead: string;
	paths: GuidancePath[];
	/** One line per path, for short terminals (see COMPACT_BELOW_ROWS). */
	compact: string[];
}

/**
 * Below this many terminal rows the card takes its 3-line compact form. The
 * full card is 12 rows; with the header, input and footer around it, a
 * shorter terminal would squeeze the input box (seen at 80x24).
 */
export const COMPACT_BELOW_ROWS = 30;

/**
 * The card's words. Commands are the real ones: the Ollama install script and
 * library tag were checked against ollama.com, the key file is the one
 * `loadEnvFile()` reads at start, and `/provider` names are the TUI's own.
 */
export function guidanceCopy(platform: NodeJS.Platform = process.platform): GuidanceCopy {
	const install =
		platform === "linux"
			? "curl -fsSL https://ollama.com/install.sh | sh"
			: "Install Ollama from https://ollama.com/download";
	return {
		label: "NO MODEL",
		lead: "8gent needs a model to answer. Pick one, or type /provider.",
		paths: [
			{
				n: "1",
				title: "Run a model on this machine (free, stays local)",
				steps: [install, "ollama pull qwen3.5", "In 8gent: /provider ollama"],
			},
			{
				n: "2",
				title: "Use a free hosted model, key from https://openrouter.ai/keys",
				steps: [
					"Add OPENROUTER_API_KEY=<your key> to ~/.8gent/.env",
					"Restart 8gent. In 8gent: /provider openrouter-free",
				],
			},
		],
		compact: [
			"Install Ollama (ollama.com), ollama pull qwen3.5, /provider ollama",
			"Put OPENROUTER_API_KEY in ~/.8gent/.env, restart, use /provider",
		],
	};
}
