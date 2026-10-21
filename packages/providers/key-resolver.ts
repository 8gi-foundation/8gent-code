/**
 * One key resolver for every path that talks to a provider (#4622).
 *
 * The TUI, `8gent run` and the AI-SDK path (packages/ai/providers.ts) used to
 * each decide for themselves which env var held a provider's key. The AI-SDK
 * path only knew four providers, so a headless run on minimax sent nothing
 * ("No API key for minimax") with MINIMAX_API_KEY set. Now every path asks the
 * provider registry: the entry's own env var, then the key vault, then a plain
 * `apiKey` in providers.json (ProviderManager.getApiKey). keys.env reaches
 * process.env at start-up (bin/8gent.ts), so it is covered by the env step.
 *
 * Never falls back to another provider's key: only the entry's own names are read.
 */
import { getProviderManager } from "./index";
import { isLocalProvider } from "./local-providers";
import { emitNotice } from "./locality-wire";

function hostOf(url: string | undefined): string {
	try {
		return new URL(url ?? "").host;
	} catch {
		return "";
	}
}

/**
 * Why this provider's key is not released, or undefined when it is. The key goes
 * only to the provider's compiled-in host, unless the user's own data dir moved
 * it (a custom endpoint they wrote). A providers.json from anywhere else, such
 * as one a cloned repo's .env pointed us at, never gets a key (#4622).
 */
export function keyWithheldReason(name: string): string | undefined {
	try {
		const pm = getProviderManager();
		const compiled = pm.compiledBaseUrl(name);
		const effective = hostOf(pm.getProvider(name).baseUrl);
		if (pm.settingsTrusted) return undefined;
		if (compiled && hostOf(compiled) === effective) return undefined;
		if (!compiled && !effective) return undefined;
		return `${name} points at ${effective || "an unknown host"}, which is not its default host${
			compiled ? ` (${hostOf(compiled)})` : ""
		}, and that setting did not come from your own ~/.8gent folder`;
	} catch {
		return undefined;
	}
}

const noticed = new Set<string>();

/** This provider's key, or undefined. Reads only this provider's own entry. */
export function resolveProviderKey(name: string): string | undefined {
	try {
		const why = keyWithheldReason(name);
		if (why) {
			if (!noticed.has(why)) {
				noticed.add(why);
				emitNotice(`Key for ${name} not sent: ${why}.`);
			}
			return undefined;
		}
		return getProviderManager().getApiKey(name)?.trim() || undefined;
	} catch {
		return undefined;
	}
}

/** The registry's base URL for a provider, or undefined when it has none. */
export function resolveProviderBaseUrl(name: string): string | undefined {
	try {
		const url = getProviderManager().getProvider(name).baseUrl?.trim();
		return url || undefined;
	} catch {
		return undefined;
	}
}

/** The env var a user sets for this provider's key (registry entry first). */
export function providerKeyEnvName(name: string): string {
	try {
		const cfg = getProviderManager().getProvider(name);
		if (cfg.apiKeyEnv) return cfg.apiKeyEnv;
	} catch {
		/* fall through */
	}
	return `${name.replace(/[^a-z0-9]/gi, "_").toUpperCase()}_API_KEY`;
}

/** The plain refusal a user reads when a hosted provider has no key. */
export function missingKeyMessage(name: string, host?: string): string {
	let extra = "";
	try {
		const why = keyWithheldReason(name);
		if (why) extra = ` The key was held back: ${why}.`;
		else if (getProviderManager().plainKeyRefused(name))
			extra =
				" A plain apiKey in providers.json is not used for a custom endpoint; store it with /apikeys.";
	} catch {
		/* the message is still useful without the extra line */
	}
	return (
		`No API key for ${name}${host ? `, so nothing was sent to ${host}` : ""}. ` +
		`Add your key with \`8gent keys\` (${providerKeyEnvName(name)}), or pick a local provider.${extra}`
	);
}

/**
 * True when the registry says this provider is a hosted, keyed, OpenAI-shaped
 * endpoint that the native chat path can drive. Data-driven: no provider list.
 */
export function isHostedChatProvider(name: string): boolean {
	try {
		const pm = getProviderManager();
		if (!pm.isKnownProvider(name) || isLocalProvider(name)) return false;
		const cfg = pm.getProvider(name);
		if (!/^https?:\/\//.test(cfg.baseUrl || "")) return false;
		if (!cfg.apiKeyEnv && !cfg.apiKeyRef) return false;
		return pm.compatFor(cfg) === "openai";
	} catch {
		return false;
	}
}
