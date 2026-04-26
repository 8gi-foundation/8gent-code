/**
 * Dispatch policy gate.
 *
 * Evaluates whether a dispatch from one surface to another is allowed.
 * Two layers:
 *   1. Per-channel default capability table (read / write_basic / write_full / admin)
 *   2. NemoClaw policy hook via evaluatePolicy("dispatch", ctx) so YAML
 *      policies can deny / require_approval per channel pair.
 *
 * The capability table mirrors the issue spec (#1896):
 *   - computer (Mac panel, locally authed): full
 *   - os/app (Clerk-authed web): full
 *   - telegram, discord (bot bridges): READ + write_basic only;
 *     write_full requires second-factor approval on the originator
 *   - api: scope per token grant (caller controls)
 *   - mobile: read default, write_full requires second-factor
 */

import type { DaemonChannel, DispatchCapability } from "../daemon/types";
import { evaluatePolicy } from "./policy-engine.js";
import type { PolicyDecision } from "./types.js";

/**
 * Default capabilities per channel. A surface registering on this
 * channel may hold AT MOST these capabilities. Token claims are
 * intersected with this table at registration time.
 *
 * Per-tenant override is allowed via runtime addPolicy() - documented
 * in the user's settings.
 */
export const CHANNEL_DEFAULT_CAPS: Record<DaemonChannel, DispatchCapability[]> = {
	computer: ["read", "write_basic", "write_full", "admin"],
	os: ["read", "write_basic", "write_full", "admin"],
	app: ["read", "write_basic", "write_full"],
	api: [], // Empty = caller controls scope per minted token.
	telegram: ["read", "write_basic"],
	discord: ["read", "write_basic"],
	delegation: ["read", "write_basic", "write_full"],
};

/** Capabilities that require second-factor approval on the originator. */
const SECOND_FACTOR_CAPS: ReadonlySet<DispatchCapability> = new Set(["write_full", "admin"]);

/**
 * Channels considered "lite" - not allowed to send write_full / admin
 * dispatches without a separate approval prompt on the originator. The
 * issue spec calls this out for telegram/discord/mobile.
 */
const LITE_CHANNELS: ReadonlySet<DaemonChannel> = new Set(["telegram", "discord"]);

export interface DispatchPolicyInput {
	fromChannel: DaemonChannel;
	fromCapabilities: DispatchCapability[];
	toChannel: DaemonChannel;
	capabilityRequired: DispatchCapability;
	intent: string;
	userId: string;
}

/**
 * Returns allowed=true on success or allowed=false with a reason.
 * `requiresApproval=true` means a second-factor confirmation must be
 * collected on the originating surface before the dispatch fires.
 */
export function evaluateDispatchPolicy(input: DispatchPolicyInput): PolicyDecision {
	// 1. The originating surface must hold the requested capability.
	if (!input.fromCapabilities.includes(input.capabilityRequired)) {
		return {
			allowed: false,
			reason: `surface on channel "${input.fromChannel}" does not hold capability "${input.capabilityRequired}"`,
		};
	}

	// 2. Lite channels cannot dispatch high-privilege actions without a
	//    second factor. The router treats `requiresApproval` as a
	//    capability_denied result so the originator can prompt the user.
	if (LITE_CHANNELS.has(input.fromChannel) && SECOND_FACTOR_CAPS.has(input.capabilityRequired)) {
		return {
			allowed: false,
			reason: `dispatches with capability "${input.capabilityRequired}" from "${input.fromChannel}" require second-factor approval`,
			requiresApproval: true,
		};
	}

	// 3. Channel defaults at the receiving end - confirm the target
	//    channel even hosts that capability. Empty list means "scope per
	//    grant" (api), which is fine - we trust the caller's token there.
	const targetCaps = CHANNEL_DEFAULT_CAPS[input.toChannel];
	if (targetCaps && targetCaps.length > 0 && !targetCaps.includes(input.capabilityRequired)) {
		return {
			allowed: false,
			reason: `target channel "${input.toChannel}" does not host capability "${input.capabilityRequired}"`,
		};
	}

	// 4. NemoClaw policy hook - YAML can deny per channel pair.
	const decision = evaluatePolicy("run_command", {
		// We re-use run_command as the action key because the policy
		// engine's enum is closed; the channel pair is what's distinctive
		// in the context. Future: extend PolicyActionType with "dispatch".
		command: `dispatch:${input.fromChannel}->${input.toChannel}:${input.capabilityRequired}`,
		dispatchFromChannel: input.fromChannel,
		dispatchToChannel: input.toChannel,
		dispatchCapability: input.capabilityRequired,
		userId: input.userId,
	});
	if (!decision.allowed) return decision;

	return { allowed: true };
}

/**
 * Intersect a token's claimed capabilities with the channel's default
 * capability ceiling. The registry uses this so a token can never
 * grant more than the channel's table allows.
 */
export function intersectChannelCaps(
	channel: DaemonChannel,
	claimed: DispatchCapability[],
): DispatchCapability[] {
	const ceiling = CHANNEL_DEFAULT_CAPS[channel] ?? [];
	if (ceiling.length === 0) {
		// Empty ceiling = caller controls. Trust the claimed list as-is.
		return [...claimed];
	}
	return claimed.filter((c) => ceiling.includes(c));
}
