/**
 * Role routing for the calls that are not the work (#73): the provider config a
 * role should run on. `main` role or no roles set returns the session's own
 * config untouched, so behaviour is exactly as before.
 */
import type { ProviderConfig, ProviderName } from "../ai";
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
