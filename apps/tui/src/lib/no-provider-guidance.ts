/**
 * First run with no model (T5): when nothing can answer, say how to connect one.
 *
 * A bare machine (no Ollama, no LM Studio, no keys) used to open to "READY"
 * with "providers 0/3" in the status bar and nothing else. Whether the card
 * shows is decided in lib/readiness.ts (#3290), the one answer the header
 * strip also renders from; this file holds the card's words, the key check
 * and the reason line.
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
 * The card's reason line from agent init's readiness result, naming the
 * engine and the address it was tried at, so a wrong OLLAMA_HOST is visible.
 * `reason` is provider-readiness's own wording ("not reachable", "no answer
 * within 3s", "http 500", "no models").
 */
export function unreachableLine(label: string, address: string, reason: string): string {
	const at = `${label} at ${address}`;
	if (reason === "not reachable") return `${at} did not answer.`;
	const within = /^no answer (within .+)$/.exec(reason);
	if (within) return `${at} did not answer ${within[1]}.`;
	if (reason === "no models") return `${at} has no models yet.`;
	return `${at} answered with ${reason}.`;
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
	/** The short-terminal form: lines per path, in path order (see COMPACT_BELOW_ROWS). */
	compact: string[][];
}

/**
 * Below this many terminal rows the card takes its 3-line compact form. The
 * full card is 13 rows; with the header, input and footer around it, a
 * shorter terminal would squeeze the input box (seen at 80x24).
 */
export const COMPACT_BELOW_ROWS = 30;

/**
 * The card's words. Commands are the real ones and follow the published docs
 * (8gent.dev models/ollama and models/hosted): the Ollama install script and
 * library tag were checked against ollama.com, and qwen3.5 is the Ollama
 * default model in packages/providers/index.ts. Keys go in ~/.8gent/keys.env
 * via `8gent keys` (the file `8gent keys status` reads and bin/8gent.ts loads).
 * Shell lines are pasteable as they stand: notes ride in `#` comments.
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
				steps: [install, "ollama pull qwen3.5   # about 7 GB", "In 8gent: /provider ollama"],
			},
			{
				n: "2",
				title: "Use a free hosted model, key from https://openrouter.ai/keys",
				steps: [
					"8gent keys   # opens ~/.8gent/keys.env",
					"Set OPENROUTER_API_KEY=<your key>, save, restart 8gent",
					"In 8gent: /provider openrouter, then /model auto:free",
				],
			},
		],
		compact: [
			["Install Ollama (ollama.com), ollama pull qwen3.5, /provider ollama"],
			[
				"8gent keys, set OPENROUTER_API_KEY=<your key>, restart 8gent",
				"/provider openrouter, then /model auto:free",
			],
		],
	};
}
