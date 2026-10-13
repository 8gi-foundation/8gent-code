/**
 * The provider config for one step of the native failover chain (#3261).
 *
 * The session's provider config carries the endpoint and key the host pinned
 * for THIS session (AgentConfig.baseUrl / apiKey). The failover loop used to
 * build each step as `{ name, model }`, which dropped both: even the first
 * attempt on the session's own provider went to the default endpoint, and
 * went out without the session's key.
 *
 * The rule, per step:
 * - Same provider as the session: keep the session's baseURL, apiKey and
 *   headers, swap only the model. They are this provider's credentials.
 * - Any other provider: resolve it the way the session start resolves a
 *   provider the host pinned nothing for, i.e. leave baseURL and apiKey unset
 *   so createModel() applies that provider's own default endpoint and its own
 *   env key. Never carry the session's key or endpoint across: that would
 *   send one provider's credential to another provider's host.
 */

import type { ProviderConfig, ProviderName } from "../ai/providers";

export interface FailoverStep {
	provider: string;
	model: string;
}

export function providerConfigForStep(session: ProviderConfig, step: FailoverStep): ProviderConfig {
	if (step.provider === session.name) {
		return { ...session, model: step.model };
	}
	return { name: step.provider as ProviderName, model: step.model };
}

/**
 * Whether a turn may move from `from` to `to` (#3746). A pinned provider (the
 * user named it) only ever moves within itself; an un-pinned session follows
 * the adaptive router wherever it goes.
 */
export function mayMoveToProvider(pinned: boolean | undefined, from: string, to: string): boolean {
	return !pinned || from === to;
}

/** The turn's error when a pinned provider failed and nothing else was tried (#3746). */
export function pinnedProviderError(provider: string, model: string, error: string): Error {
	return new Error(
		`${provider}/${model} failed: ${error}\n` +
			`The provider was chosen explicitly, so no other provider was tried. ` +
			`Check that ${provider} is running and serves "${model}", or run without --provider to let 8gent pick one.`,
	);
}

/**
 * The apiKey a host should put on an AgentConfig for `runtime` (#3261).
 *
 * AgentConfig.apiKey is the session provider's own key: the native path sends
 * it to the session endpoint on every leg of that provider. Hosts used to pass
 * OPENROUTER_API_KEY whatever the runtime, so an ollama or lmstudio session
 * would have sent the OpenRouter key to the ollama or LM Studio host (which
 * can be remote). Only an openrouter session gets the OpenRouter key here;
 * every other runtime gets none, and each provider then resolves its own key
 * from its own env var (createModel, createClient, VisionInterpreter all
 * fall back to the env themselves).
 */
export function sessionApiKey(
	runtime: string,
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	return runtime === "openrouter" ? env.OPENROUTER_API_KEY || undefined : undefined;
}
