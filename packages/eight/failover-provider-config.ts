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
