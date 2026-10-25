/**
 * The glue between a tab's provider and model and the window resolver (#5035):
 * which local servers to ask, and the one hosted endpoint (with the key the
 * owner already set for it) whose own models list answers for a hosted model.
 */

import { resolveOllamaBaseUrl } from "../../../../packages/ai/text-tool-endpoint.js";
import { resolveLlamaServerUrl } from "../../../../packages/local-model-server/index.js";
import { getProviderManager } from "../../../../packages/providers/index.js";
import {
	type ContextWindow,
	UNKNOWN_WINDOW,
	resolveContextWindowCached,
} from "./context-window.js";

export async function resolveTabWindow(
	provider: string,
	model: string,
	signal?: AbortSignal,
): Promise<ContextWindow> {
	let baseUrl: string | undefined;
	let apiKey: string | undefined;
	try {
		const manager = getProviderManager();
		// biome-ignore lint/suspicious/noExplicitAny: provider names are validated by the manager itself
		const p = manager.getProvider(provider as any);
		baseUrl = p?.baseUrl || undefined;
		// biome-ignore lint/suspicious/noExplicitAny: same
		apiKey = manager.getApiKey(provider as any) || undefined;
	} catch {
		// An unknown provider has no models list to ask.
	}
	return resolveContextWindowCached({
		provider,
		model,
		baseUrl,
		apiKey,
		ollamaBaseUrl: resolveOllamaBaseUrl(),
		llamaServerUrl: resolveLlamaServerUrl(),
		signal,
	}).catch(() => UNKNOWN_WINDOW);
}
