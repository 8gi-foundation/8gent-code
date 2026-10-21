/**
 * #4598: three small truths for the provider UI.
 *
 *  1. The Select Provider list is built from the provider registry, so every
 *     registered provider appears and "key configured" means a key is present.
 *  2. A model is only shown and used with the provider that owns it.
 *  3. A provider that cannot start says why: no key names the key and the fix;
 *     a failed model fetch says the HTTP status.
 *
 * Pure: the registry is passed in, nothing here reads the disk or the net.
 * No model names live here.
 */

import { keyLooksUsable, noModelMessage } from "../../../../packages/providers/no-model-message.js";
import type { ProviderOption } from "../components/select-input";
import type { LiveModelsReader } from "./model-selection";
import { declaredModels } from "./model-selection";

/** The slice of ProviderManager the picker needs. */
export interface ProviderRegistryReader {
	listProviders(): Array<{
		name: string;
		displayName: string;
		apiKeyEnv: string;
		apiKeyRef?: string;
		enabled: boolean;
	}>;
	getApiKey(name: string): string | null;
}

/**
 * One picker row per registered provider. `hasApiKey` is true only when the
 * provider's key is present (env, keys.env loaded at launch, or the vault).
 * A provider that is off by default but has a key is selectable, matching
 * ProviderManager.listEnabledProviders. TUI-only "openrouter-free" follows
 * "openrouter" and shares its key.
 */
export function buildProviderOptions(reg: ProviderRegistryReader): ProviderOption[] {
	let list: ReturnType<ProviderRegistryReader["listProviders"]>;
	try {
		list = reg.listProviders();
	} catch {
		return [];
	}
	const out: ProviderOption[] = [];
	for (const p of list) {
		const needsKey = Boolean(p.apiKeyEnv || p.apiKeyRef);
		let hasKey = false;
		try {
			hasKey = needsKey && Boolean(reg.getApiKey(p.name));
		} catch {
			hasKey = false;
		}
		out.push({
			name: p.name,
			displayName: p.displayName,
			hasApiKey: hasKey,
			needsKey,
			enabled: p.enabled || hasKey,
		});
		if (p.name === "openrouter") {
			out.push({
				name: "openrouter-free",
				displayName: `${p.displayName} (free models)`,
				hasApiKey: hasKey,
				needsKey,
				enabled: true,
			});
		}
	}
	return out;
}

/** Does a fetched model list belong to the provider now active? */
export function listBelongsToProvider(owner: string, current: string): boolean {
	return owner === current;
}

/**
 * Whether a provider with no model has really run out of models: only once its own
 * list has loaded, empty. Right after /provider the list is still on its way; when it
 * lands with models, autoSelectModel picks one in the same render, so an empty model
 * then is not a failure either (#4682).
 */
export function emptyModelIsFinal(opts: {
	loading: boolean;
	owner: string;
	provider: string;
	/** How many models the loaded list holds. */
	listed: number;
}): boolean {
	return !opts.loading && listBelongsToProvider(opts.owner, opts.provider) && opts.listed === 0;
}

/**
 * The model to hold after the provider changes: the same provider keeps its
 * model, a different one starts empty so its own live list (or the user's
 * saved choice for it) decides. A model never follows a provider switch.
 */
export function modelAfterProviderSwitch(from: string, to: string, model: string): string {
	return from === to ? model : "";
}

/** Why a keyed provider cannot start, or null when the key is present or not needed. */
export function providerKeyNotice(
	p: { displayName: string; apiKeyEnv: string; apiKeyRef?: string },
	hasKey: boolean,
): string | null {
	if (hasKey) return null;
	const env = p.apiKeyEnv || p.apiKeyRef;
	if (!env) return null;
	return `${p.displayName} needs ${env}. Add it with \`8gent keys\`.`;
}

/**
 * The key notice for the provider the registry knows by this name, or null
 * (unknown name, no key needed, or key present). OpenRouter keeps its own
 * longer notice (missingKeyNotice); the TUI alias "openrouter-free" is skipped
 * here for the same reason.
 */
export function registryKeyNotice(
	provider: string,
	reader: {
		isKnownProvider(name: string): boolean;
		getProvider(name: string): { displayName: string; apiKeyEnv: string; apiKeyRef?: string };
		getApiKey(name: string): string | null;
	},
): string | null {
	if (provider === "openrouter" || provider === "openrouter-free") return null;
	try {
		if (!reader.isKnownProvider(provider)) return null;
		return providerKeyNotice(
			reader.getProvider(provider),
			keyLooksUsable(reader.getApiKey(provider)),
		);
	} catch {
		return null;
	}
}

/** Why a model list could not be had, from the discovery error. Key is present here. */
export function modelListFailureNotice(displayName: string, err: unknown): string {
	const msg = err instanceof Error ? err.message : err ? String(err) : "";
	const status = /: (\d{3})\b/.exec(msg)?.[1];
	if (status === "401" || status === "403") {
		return noModelMessage({
			displayName,
			keyEnv: "",
			key: null,
			err,
			pickHint: "Pick a model with /model.",
		});
	}
	if (status) {
		return `No model chosen for ${displayName}: its model list request failed with HTTP ${status}. Pick a model with /model.`;
	}
	if (/timed out/i.test(msg)) {
		return `No model chosen for ${displayName}: its model list request timed out. Pick a model with /model.`;
	}
	if (msg) {
		return `No model chosen for ${displayName}: its model list request failed (${msg.slice(0, 120)}). Pick a model with /model.`;
	}
	return `No model chosen for ${displayName}: its model list request returned no models. Pick a model with /model.`;
}

/** Like listProviderModels, but keeps the error so the caller can say why. */
/** Longest the TUI waits for a provider's model list before treating it as failed (#4683). */
export const MODEL_LIST_TIMEOUT_MS = 15_000;

/**
 * Wait for a model-list load, or reject with a "timed out" error after `ms`, so a
 * request that never answers cannot leave the list loading forever (#4683). The
 * message gives modelListFailureNotice its timed-out reason.
 */
export async function loadModelListWithin(
	load: Promise<unknown>,
	ms: number = MODEL_LIST_TIMEOUT_MS,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<"late">((resolve) => {
		timer = setTimeout(() => resolve("late"), ms);
	});
	const done = await Promise.race([load.then(() => "done" as const), deadline]).finally(() =>
		clearTimeout(timer),
	);
	if (done === "late") throw new Error(`model list request timed out after ${ms / 1000} s`);
}

export async function listModelsWithReason(
	reader: LiveModelsReader,
	provider: string,
): Promise<{ models: string[]; error?: unknown }> {
	if (!provider || !reader.isKnownProvider(provider)) return { models: [] };
	try {
		const live = (await reader.discoverModels(provider))
			.map((m) => String(m).trim())
			.filter((m) => m.length > 0);
		if (live.length > 0) return { models: live };
		return { models: declaredModels(reader, provider) };
	} catch (error) {
		return { models: declaredModels(reader, provider), error };
	}
}
