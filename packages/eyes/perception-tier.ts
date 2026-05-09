/**
 * perception:remote tier per spec §4.2 and §8.4.
 *
 * The eyes contract requires that any describe()/locate(describe) call which
 * sends frame bytes off-device first hold the perception:remote tier for the
 * current session/app. The control plane (or session config) calls grant();
 * the backend calls check() before egress and writes the audit trail.
 *
 * Hard rule from §8.4: gate fires on RUNTIME data egress, not on backend
 * identity. The same describe() call can land on either tier depending on
 * failover state at runtime; gating on backend identity would be wrong.
 *
 * This module owns the runtime state. The 3-button consent UX
 * ([Once] [This session] [Always for this app]) lives in the control plane.
 */

import { logAccess } from "@8gent/audit";

export type PerceptionTierScope = "once" | "session" | "app";

export interface PerceptionGrant {
	scope: PerceptionTierScope;
	app?: string;        // bundle id, required when scope === "app"
	sessionId?: string;  // matched against the session presented to check()
	grantedAt: number;
}

export interface CheckArgs {
	sessionId?: string;
	app?: string;
	provider: string;     // resolved provider id from the chain
	calledFrom: string;   // tool name or call site, for audit
	actor?: string;       // agent / user id
}

export type CheckResult =
	| { ok: true; mode: "local"; provider: string }
	| { ok: true; mode: "remote-granted"; grant: PerceptionGrant; provider: string }
	| { ok: false; reason: string; provider: string };

/**
 * Provider ids that resolve fully on-device. Anything else triggers the gate.
 * Source: provider chain audit during eyes recon (2026-05-09).
 */
export const LOCAL_PROVIDERS: ReadonlySet<string> = new Set([
	"8gent",
	"ollama",
	"apfel",
	"apple-foundation",
	"lm-studio",
]);

export function isRemoteProvider(provider: string): boolean {
	return !LOCAL_PROVIDERS.has(provider);
}

/**
 * The grant store is module-scoped because the eyes backend is a singleton
 * for the process lifetime. If we ever multi-tenant the backend, this becomes
 * a per-instance map keyed by the backend instance id.
 */
const _grants: PerceptionGrant[] = [];
let _consumedOnce = false;

export function resetPerceptionTier(): void {
	_grants.length = 0;
	_consumedOnce = false;
}

export function grantPerceptionRemote(
	scope: PerceptionTierScope,
	opts: { app?: string; sessionId?: string; now?: () => number } = {},
): PerceptionGrant {
	if (scope === "app" && !opts.app) {
		throw new Error("perception:remote scope=app requires opts.app (bundle id)");
	}
	const now = opts.now ?? Date.now;
	const grant: PerceptionGrant = {
		scope,
		app: opts.app,
		sessionId: opts.sessionId,
		grantedAt: now(),
	};
	_grants.push(grant);
	if (scope === "once") _consumedOnce = false;
	logAccess({
		actor: opts.sessionId ?? "system",
		actorKind: "system",
		targetTable: "perception_tier",
		targetId: `grant:${scope}:${opts.app ?? "any"}`,
		operation: "derive",
		reason: `granted perception:remote scope=${scope}`,
		sessionId: opts.sessionId ?? null,
	});
	return grant;
}

export function revokePerceptionRemote(opts: { sessionId?: string; app?: string } = {}): number {
	const before = _grants.length;
	for (let i = _grants.length - 1; i >= 0; i--) {
		const g = _grants[i];
		if (!g) continue;
		const matchSession = !opts.sessionId || g.sessionId === opts.sessionId;
		const matchApp = !opts.app || g.app === opts.app;
		if (matchSession && matchApp) _grants.splice(i, 1);
	}
	const dropped = before - _grants.length;
	if (dropped > 0) {
		logAccess({
			actor: opts.sessionId ?? "system",
			actorKind: "system",
			targetTable: "perception_tier",
			targetId: `revoke:${opts.app ?? "any"}`,
			operation: "derive",
			reason: `revoked ${dropped} perception:remote grants`,
			sessionId: opts.sessionId ?? null,
		});
	}
	return dropped;
}

export function findActiveGrant(
	sessionId: string | undefined,
	app: string | undefined,
): PerceptionGrant | null {
	for (const g of _grants) {
		if (g.scope === "session" && g.sessionId === sessionId) return g;
		if (g.scope === "app" && g.app && g.app === app) return g;
		if (g.scope === "once" && !_consumedOnce) return g;
	}
	return null;
}

/**
 * The gate. Called by the backend immediately before any operation that would
 * send frame bytes off-device. Behaviour:
 *
 *   - provider is local (LOCAL_PROVIDERS) -> ok: true, no grant needed
 *   - provider is remote AND active grant exists -> ok: true, audit egress
 *   - provider is remote AND no grant -> ok: false, audit denial
 *
 * Always writes to the audit store regardless of outcome.
 */
export function checkPerceptionRemote(args: CheckArgs): CheckResult {
	const { provider, sessionId, app, calledFrom, actor } = args;

	if (!isRemoteProvider(provider)) {
		logAccess({
			actor: actor ?? sessionId ?? "system",
			actorKind: "agent",
			targetTable: "perception_call",
			targetId: `local:${provider}:${calledFrom}`,
			operation: "read",
			reason: `${calledFrom} resolved to local provider; perception:remote not required`,
			sessionId: sessionId ?? null,
		});
		return { ok: true, mode: "local", provider };
	}

	const grant = findActiveGrant(sessionId, app);
	if (!grant) {
		logAccess({
			actor: actor ?? sessionId ?? "system",
			actorKind: "agent",
			targetTable: "perception_call",
			targetId: `denied:${provider}:${calledFrom}`,
			operation: "read",
			reason: `${calledFrom} blocked: perception:remote not granted (provider=${provider})`,
			sessionId: sessionId ?? null,
		});
		return {
			ok: false,
			reason: "perception:remote not granted",
			provider,
		};
	}

	if (grant.scope === "once") _consumedOnce = true;
	logAccess({
		actor: actor ?? sessionId ?? "system",
		actorKind: "agent",
		targetTable: "perception_call",
		targetId: `egress:${provider}:${calledFrom}`,
		operation: "export",
		reason: `${calledFrom} sent frame to remote provider ${provider} under perception:remote scope=${grant.scope}`,
		sessionId: sessionId ?? null,
	});
	return { ok: true, mode: "remote-granted", grant, provider };
}
