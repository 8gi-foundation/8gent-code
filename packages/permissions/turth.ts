/**
 * 8gent Code - Turth (interactive scoped approval prompt)
 *
 * Wires NemoClaw's policy engine to the TUI + Telegram prompt surfaces.
 * Name is inspired by a four-scope permission prompt we studied
 * (allow once / allow for session / permanent allow / deny), rebuilt from scratch.
 *
 * Feature-flagged on PERMISSIONS_INTERACTIVE=1. Default behaviour is unchanged.
 *
 * Security posture (8SO):
 *   - Agents never answer their own prompt; prompts are resolved by a human surface.
 *   - Deny propagates as a PolicyDecision with allowed:false and a stable reason.
 *   - Every decision is audit-logged (see user-policy.ts).
 */

import type { PolicyDecision } from "./types.js";
import { type ApprovalScope, checkCapability, recordDecision } from "./user-policy.js";

export type { ApprovalScope } from "./user-policy.js";

export interface TurthRequest {
	/** Stable capability identifier, e.g. "run_command:git_push" or "write_file:~/.ssh". */
	capability: string;
	/** Human-readable summary shown to the user in the prompt. */
	summary: string;
	/** Optional detail string (command, path, etc.). */
	detail?: string;
	/** Actor identifier for audit (defaults to "agent"). */
	actor?: string;
	/** cwd for project-scoped decisions (defaults to process.cwd()). */
	cwd?: string;
}

export type PromptSurface = (req: TurthRequest) => Promise<ApprovalScope>;

let _surface: PromptSurface | null = null;

/**
 * Register the active prompt surface (TUI overlay or Telegram).
 * The last registered surface wins. Passing null unregisters.
 */
export function registerPromptSurface(surface: PromptSurface | null): void {
	_surface = surface;
}

/** Is the interactive Turth system enabled via feature flag? */
export function isInteractiveEnabled(): boolean {
	return process.env.PERMISSIONS_INTERACTIVE === "1";
}

/**
 * Request approval for a capability. Returns a PolicyDecision compatible
 * with the rest of the permissions package so callers can treat it uniformly.
 *
 * Resolution order:
 *   1. Feature flag off: returns allowed:true (callers fall through to the
 *      existing NemoClaw + PermissionManager gates, unchanged).
 *   2. Cached decision (session / project / always): returned without prompting.
 *   3. No surface registered: fail-closed with requiresApproval:true so the
 *      caller can fall back to the existing interactive prompt path.
 *   4. Surface registered: ask the user, cache per chosen scope, return.
 */
export async function requestApproval(req: TurthRequest): Promise<PolicyDecision> {
	if (!isInteractiveEnabled()) {
		return { allowed: true };
	}

	const cached = checkCapability(req.capability, req.cwd);
	if (cached) {
		return cached.allowed
			? { allowed: true }
			: {
					allowed: false,
					reason: `User denied capability "${req.capability}" at scope=${cached.scope}`,
				};
	}

	if (!_surface) {
		// Fail closed: no surface = treat as "requires approval" so the caller
		// falls back to the existing readline prompt (PermissionManager) rather
		// than silently allowing.
		return {
			allowed: false,
			reason: `No Turth prompt surface registered for "${req.capability}"`,
			requiresApproval: true,
		};
	}

	const scope = await _surface(req);
	const decision = recordDecision(req.capability, scope, {
		actor: req.actor ?? "agent",
		cwd: req.cwd,
	});

	if (decision.allowed) {
		return { allowed: true };
	}
	return {
		allowed: false,
		reason: `User denied capability "${req.capability}" via Turth prompt`,
	};
}
