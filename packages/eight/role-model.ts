/**
 * Role routing for the calls that are not the work (#73): the provider config a
 * role should run on. `main` role or no roles set returns the session's own
 * config untouched, so behaviour is exactly as before.
 */
import type { ProviderConfig, ProviderName } from "../ai";
import { forceLocalModel, privacyGate } from "../permissions/privacy-router";
import { providerAllowed } from "../providers/failover";
import { type PolicyState, decideRoute } from "../providers/locality";
import { type Role, resolveRole } from "../providers/roles";
import type { RolesSettings } from "../settings/schema";

export interface RoleKeys {
	hasCredentials(provider: string): boolean;
	getApiKey(provider: string): string | null;
}

export function providerConfigForRole(
	role: Role,
	roles: RolesSettings | undefined | null,
	session: ProviderConfig,
	keys: RoleKeys,
): ProviderConfig {
	const r = resolveRole(
		role,
		roles,
		{ provider: session.name, model: session.model },
		(p) => keys.hasCredentials(p),
	);
	if (r.source === "session") return session;
	if (r.target.provider === session.name && r.target.model === session.model) return session;
	// A different provider: its own key and endpoint, never the session's.
	const sameProvider = r.target.provider === session.name;
	return {
		name: r.target.provider as ProviderName,
		model: r.target.model,
		apiKey: sameProvider ? session.apiKey : (keys.getApiKey(r.target.provider) ?? undefined),
		baseURL: sameProvider ? session.baseURL : undefined,
	};
}

/** What the main call is held to this turn, for a role that would receive the history. */
export interface HistoryGates {
	/** The routing policy (readPolicyState). local-only refuses any hosted call. */
	policy: PolicyState;
	/** File paths this session touched; a sensitive one (a .env read) holds the turn local. */
	recentFilePaths: string[];
	/** True when the config runs on this machine (agent.ts runsOnBox). */
	runsLocal(cfg: ProviderConfig): boolean;
}

/**
 * Whether `cfg` may receive the conversation: the same gates the main call
 * passes. The provider allowlist (EIGHT_ALLOW_HOSTED, EIGHT_PROVIDERS_ALLOW),
 * then, for a hosted target, the privacy gate and the routing policy.
 */
export function historyMayGoTo(cfg: ProviderConfig, gates: HistoryGates): boolean {
	if (!providerAllowed(cfg.name)) return false;
	if (gates.runsLocal(cfg)) return true;
	if (privacyGate(gates.recentFilePaths, cfg.name).shouldForceLocal) return false;
	const route = decideRoute({
		policy: gates.policy.policy,
		provider: cfg.name,
		local: false,
		// Written down by the person in models.roles, as a tab's provider is picked.
		pickedForTab: true,
		why: gates.policy.why,
	});
	return route.action === "allow-cloud";
}

/**
 * The config the small role (compaction, summaries) runs on, held to the main
 * call's gates. A role target the gates refuse falls back to the session; a
 * session the privacy gate holds local falls back to the local model, as the
 * main call does. History never reaches a provider the turn could not use.
 */
export function smallRoleConfigFor(
	roles: RolesSettings | undefined | null,
	session: ProviderConfig,
	keys: RoleKeys,
	gates: HistoryGates,
): ProviderConfig {
	let picked = session;
	try {
		picked = providerConfigForRole("small", roles, session, keys);
	} catch {
		picked = session;
	}
	if (picked !== session && !historyMayGoTo(picked, gates)) picked = session;
	if (!gates.runsLocal(picked) && privacyGate(gates.recentFilePaths, picked.name).shouldForceLocal) {
		const local = forceLocalModel(picked.name);
		// The forced-local provider resolves its own endpoint and key (#3261).
		if (local) return { name: local.provider as ProviderName, model: local.model };
	}
	return picked;
}
