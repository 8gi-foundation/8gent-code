import { type ProviderManager, getProviderManager } from "../providers";
import { discoverModelsAt } from "../providers/declared";
/**
 * One choice means no question (#4720).
 *
 * With a hosted key set and no local runtime answering, the person should not
 * have to open /provider: the only provider that can run is the one to use.
 * Both front doors (the TUI's first turn, `8gent run`) ask this module, so the
 * rule, its wording and what counts as "can run" live once.
 *
 * Rules:
 *  - Only a LOCAL active provider is ever swapped. A hosted provider the person
 *    chose is never replaced behind their back (no-silent-provider-swap).
 *  - "Can run" = a hosted chat provider whose key is present and long enough to
 *    be real. Other local runtimes that answer are already preferred by the
 *    readiness gate (apps/tui/src/lib/provider-readiness.ts) before this runs.
 *  - Exactly one such provider switches. Zero or several: nothing changes, and
 *    the existing "pick one with /provider" guidance stands.
 *  - The model is the provider's own live list, never a name written here.
 */
import { isHostedChatProvider, resolveProviderKey } from "../providers/key-resolver";
import { keyLooksUsable } from "../providers/no-model-message";
import { autoSwitchLine, soleRunnableProvider } from "../providers/only-runnable";
import { type ProviderChoice, saveProviderChoice } from "../self-autonomy/local-servers";
import { modelForOneShotWithReason } from "./run";

export { autoSwitchLine, localEngineLabel, soleRunnableProvider } from "../providers/only-runnable";

/** Hosted chat providers that have a usable key, in registry order. */
export function hostedKeyedProviders(): string[] {
	try {
		return getProviderManager()
			.listProviders()
			.map((p) => p.name)
			.filter((n) => isHostedChatProvider(n) && keyLooksUsable(resolveProviderKey(n)));
	} catch {
		return [];
	}
}

export interface AutoSwitch {
	provider: string;
	label: string;
	model: string;
	line: string;
}

function displayName(provider: string): string {
	try {
		return getProviderManager().getProvider(provider).displayName || provider;
	} catch {
		return provider;
	}
}

/**
 * Where to go when `active` (a local provider) is not answering. Null when the
 * rule does not apply, or when the target lists no model (the caller then says
 * why in its usual words rather than switching to nothing).
 */
export async function autoSwitchTarget(
	active: string,
	deps: {
		hosted?: () => string[];
		discover?: (p: string) => Promise<string[]>;
	} = {},
): Promise<AutoSwitch | null> {
	const provider = soleRunnableProvider(active, (deps.hosted ?? hostedKeyedProviders)());
	if (!provider) return null;
	const { model } = await modelForOneShotWithReason(provider, undefined, deps.discover);
	if (!model) return null;
	const label = displayName(provider);
	return { provider, label, model, line: autoSwitchLine(active, label, model) };
}

/**
 * Save the provider and model the person (or the rule) chose to the file the
 * onboarding choice already uses (providers.json, via saveProviderChoice), so
 * the next launch starts there. Returns false when the provider is not one the
 * registry knows (the "free models" alias is a view of OpenRouter, not a provider).
 */
export function persistProviderChoice(
	provider: string,
	model: string,
	manager: ProviderManager = getProviderManager(),
): boolean {
	try {
		if (!manager.isKnownProvider(provider)) return false;
		saveProviderChoice(
			{ provider: provider as ProviderChoice["provider"], model: model.trim() },
			manager,
		);
		return true;
	} catch {
		return false;
	}
}

export interface ProviderDoctorRow {
	provider: string;
	label: string;
	state: "answered" | "rejected" | "no-answer";
	detail: string;
}

/** Ask one provider's own model list, bounded. Never prints the key. */
async function probeHosted(provider: string): Promise<ProviderDoctorRow> {
	const pm = getProviderManager();
	const cfg = pm.getProvider(provider);
	const label = cfg.displayName || provider;
	try {
		const models = await discoverModelsAt(
			cfg.baseUrl,
			pm.compatFor(cfg),
			resolveProviderKey(provider),
			5000,
		);
		return {
			provider,
			label,
			state: "answered",
			detail: `answered, ${models.length} model${models.length === 1 ? "" : "s"} listed`,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const status = /: (\d{3})\b/.exec(msg)?.[1];
		if (status === "401" || status === "403")
			return { provider, label, state: "rejected", detail: `rejected the key (HTTP ${status})` };
		if (/timed out/i.test(msg))
			return { provider, label, state: "no-answer", detail: "did not answer within 5s" };
		return {
			provider,
			label,
			state: "no-answer",
			detail: status ? `HTTP ${status}` : "did not answer",
		};
	}
}

/** `8gent doctor`: every hosted provider with a key, and whether it answered. */
export async function providerDoctorRows(
	deps: { hosted?: () => string[]; probe?: (p: string) => Promise<ProviderDoctorRow> } = {},
): Promise<ProviderDoctorRow[]> {
	const names = (deps.hosted ?? hostedKeyedProviders)();
	return Promise.all(names.map((n) => (deps.probe ?? probeHosted)(n)));
}
