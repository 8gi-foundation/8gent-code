/**
 * Role-based model routing (#73): which provider and model a role runs on.
 *
 *   main  the work
 *   small compaction, summaries, titles
 *   slow  hard plans (optional)
 *
 * A role's setting is one target or a chain. Entries whose provider has no
 * credentials are skipped. When nothing usable is left, `small` and `slow`
 * fall back to `main`, and `main` falls back to the session's own provider and
 * model. With no roles set the answer is always the session's own, so nothing
 * changes until someone writes a role down.
 */
import type { RoleSetting, RoleTarget, RolesSettings } from "../settings/schema";

export type Role = "main" | "small" | "slow";
export const ROLES: readonly Role[] = ["main", "small", "slow"];

export interface RoleResolution {
	role: Role;
	target: RoleTarget;
	/** "role" = a configured entry; "main" = fell back to main's pick; "session" = the session's own. */
	source: "role" | "main" | "session";
	/** Providers named by this role that were skipped for want of credentials. */
	skipped: string[];
}

function chainOf(setting: RoleSetting | undefined): RoleTarget[] {
	const list = Array.isArray(setting) ? setting : setting ? [setting] : [];
	return list.filter(
		(t) =>
			t && typeof t.provider === "string" && t.provider && typeof t.model === "string" && t.model,
	);
}

export function resolveRole(
	role: Role,
	roles: RolesSettings | undefined | null,
	session: RoleTarget,
	hasCredentials?: (provider: string) => boolean,
): RoleResolution {
	const skipped: string[] = [];
	for (const t of chainOf(roles?.[role])) {
		if (hasCredentials && !hasCredentials(t.provider)) {
			skipped.push(t.provider);
			continue;
		}
		return { role, target: t, source: "role", skipped };
	}
	if (role !== "main") {
		const main = resolveRole("main", roles, session, hasCredentials);
		return { role, target: main.target, source: "main", skipped };
	}
	return { role, target: session, source: "session", skipped };
}

/** /status lines: one per role, what it runs on and why. */
export function describeRoles(
	roles: RolesSettings | undefined | null,
	session: RoleTarget,
	hasCredentials?: (provider: string) => boolean,
): string[] {
	return ROLES.map((role) => {
		const r = resolveRole(role, roles, session, hasCredentials);
		const where = `${r.target.provider}/${r.target.model}`;
		const how = r.source === "role" ? "" : r.source === "main" ? " (main)" : " (session default)";
		const skip = r.skipped.length ? ` [skipped, no key: ${r.skipped.join(", ")}]` : "";
		return `${role}: ${where}${how}${skip}`;
	});
}
