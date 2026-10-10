/**
 * Dispatch policy gate.
 *
 * Evaluates whether a dispatch from one surface to another is allowed.
 * Two layers:
 *   1. Per-channel default capability table (read / write_basic / write_full / admin)
 *   2. NemoClaw policy hook via evaluatePolicy("dispatch", ctx) so YAML
 *      policies can deny / require_approval per channel pair.
 *
 * The capability table mirrors the issue spec (#1896), with one channel
 * since re-classified:
 *   - computer (Mac panel, locally authed): full
 *   - os/app (Clerk-authed web): full
 *   - telegram (multi-user allowlisted bridge, operator session only): full
 *     for the operator. The bridge may sit in a group with other allowlisted
 *     people; it refuses their prompts and commands rather than letting them
 *     share the operator's session. See below.
 *   - discord, browser (bot bridges / untrusted page contexts): READ +
 *     write_basic only; write_full requires second-factor approval on the
 *     originator
 *   - api: scope per token grant (caller controls)
 *   - mobile: read default, write_full requires second-factor
 *
 * Why telegram is trusted and discord is not
 * ------------------------------------------
 * The original spec put every bot bridge in one category: a bot is a public
 * surface, so anyone who finds it can drive it. That holds for a Discord bot
 * sitting in a server. It does not describe how the Telegram bridge is built.
 *
 * `packages/daemon/telegram-bridge.ts` enforces a chat-id allowlist at three
 * independent points, before any inbound update produces a side effect:
 *   1. the poll loop, which drops non-allowlisted message updates ahead of
 *      transcription, typing indicators, and agent dispatch,
 *   2. `handleTelegramMessage`, which re-checks before prompting the agent,
 *   3. `handleCallbackQuery`, which re-checks before any inline-keyboard
 *      button (approve / deny / cancel / new task) changes state.
 * All three call `isAuthorizedChat`, which fails closed: with no allowlist
 * configured it accepts only the single configured chat id, and local mode
 * refuses to start unless at least one id is allowlisted.
 *
 * So this channel is not an open bot surface. It is a single-user,
 * pre-authenticated pipe to one operator, authenticated the same way the Mac
 * panel is: by possession of a local secret. A second-factor prompt on top of
 * that asked the same person, on the same device, to confirm they were
 * themselves. It bought no security and cost every ordinary action a round
 * trip, which is a real harm: gates that fire constantly on safe work train
 * the operator to approve without reading, so the gate stops working on the
 * day it matters.
 *
 * Discord and browser keep the lite treatment because they have no equivalent
 * control. There is no per-user allowlist on the Discord path, and `browser`
 * is a page context driven by whatever the page loaded. If either ever grows
 * an allowlist of this shape, revisit it deliberately. Do not widen them by
 * analogy to this entry.
 *
 * The trust rests on the allowlist, not on the bot token. A leaked token lets
 * an attacker read and impersonate the bot, but not drive the daemon, because
 * updates from any other chat id are dropped before they reach the agent. The
 * allowlist is the control; token rotation is the kill switch.
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
	// Multi-user channel: the bridge can sit in a group with several allowlisted
	// people. The ceiling is the OPERATOR's, and holds only because the bridge
	// refuses every non-operator prompt and command before it reaches the
	// daemon session (telegram-bridge.ts isCommandAllowed). Never route a
	// second person's prompt onto this channel.
	// Rationale and the three allowlist checks it depends on: file header.
	telegram: ["read", "write_basic", "write_full", "admin"],
	discord: ["read", "write_basic"],
	browser: ["read", "write_basic"],
	delegation: ["read", "write_basic", "write_full"],
	// Table is a local, in-daemon workspace channel, not a cross-surface dispatch
	// target. It never registers as a dispatch surface, so it holds no dispatch
	// capabilities (like `api`, scope is controlled at the Table layer itself).
	table: [],
};

/** Capabilities that require second-factor approval on the originator. */
const SECOND_FACTOR_CAPS: ReadonlySet<DispatchCapability> = new Set(["write_full", "admin"]);

/**
 * Channels considered "lite" - not allowed to send write_full / admin
 * dispatches without a separate approval prompt on the originator.
 *
 * `telegram` was here and is deliberately no longer, because it is allowlisted
 * to one chat id at three separate points in the bridge. See the file header
 * for the full argument. discord and browser stay because they are not.
 *
 * The second-factor mechanism below is untouched and still fires for these
 * channels, and for anything a YAML policy marks require_approval. This
 * removed one channel from the list; it did not weaken the gate.
 */
const LITE_CHANNELS: ReadonlySet<DaemonChannel> = new Set(["discord", "browser"]);

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
