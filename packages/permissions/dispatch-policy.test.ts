/**
 * Dispatch policy tests, written around one deliberate boundary change:
 * `telegram` was promoted from a "lite" bot bridge to a full-capability
 * channel, on the strength of the chat-id allowlist in the bridge.
 *
 * These tests exist to make that change hard to undo by accident and hard to
 * copy by accident. They pin three separate things:
 *   1. telegram now holds the same capabilities as computer, and its
 *      write_full / admin dispatches go through with no approval round trip,
 *   2. discord and browser are untouched and still demand a second factor,
 *   3. the second-factor mechanism still works, so a future policy that wants
 *      an approval gate can still get one.
 *
 * The allowlist itself is tested here too, because it is the load-bearing
 * control under (1). If the allowlist ever stops rejecting a foreign chat id,
 * the justification for (1) is gone and this whole file should go red.
 */

import { describe, expect, test } from "bun:test";
import { isChatAuthorized } from "../daemon/telegram-bridge";
import type { DaemonChannel, DispatchCapability } from "../daemon/types";
import {
	CHANNEL_DEFAULT_CAPS,
	evaluateDispatchPolicy,
	intersectChannelCaps,
} from "./dispatch-policy";
import type { PolicyDecision } from "./types";

/**
 * PolicyDecision is a discriminated union, and `reason` / `requiresApproval`
 * live only on the denied branch. Narrowing through this helper means a test
 * that expected a denial and got an approval fails on the assertion rather
 * than silently reading undefined off the wrong branch.
 */
function denied(decision: PolicyDecision): { reason: string; requiresApproval?: boolean } {
	if (decision.allowed) {
		throw new Error("expected this dispatch to be denied, but the policy allowed it");
	}
	return decision;
}

/**
 * The allowed branch has no `requiresApproval` field at all, so an allowed
 * dispatch structurally cannot ask for a second factor. The cast checks the
 * runtime object anyway, in case the returned shape and the union ever drift.
 */
function approvalFlag(decision: PolicyDecision): boolean | undefined {
	return (decision as { requiresApproval?: boolean }).requiresApproval;
}

/** A dispatch that differs only in the fields each test cares about. */
function dispatch(overrides: {
	fromChannel: DaemonChannel;
	capabilityRequired: DispatchCapability;
	toChannel?: DaemonChannel;
	fromCapabilities?: DispatchCapability[];
}) {
	const fromChannel = overrides.fromChannel;
	return evaluateDispatchPolicy({
		fromChannel,
		// Default to whatever the channel's ceiling allows, which is what the
		// registry would have granted at registration time.
		fromCapabilities: overrides.fromCapabilities ?? CHANNEL_DEFAULT_CAPS[fromChannel],
		toChannel: overrides.toChannel ?? "computer",
		capabilityRequired: overrides.capabilityRequired,
		intent: "restart the vessel daemon",
		userId: "user_local",
	});
}

describe("telegram is a full-capability channel", () => {
	test("holds exactly the same capabilities as computer", () => {
		expect(CHANNEL_DEFAULT_CAPS.telegram).toEqual(CHANNEL_DEFAULT_CAPS.computer);
	});

	test("holds write_full and admin", () => {
		expect(CHANNEL_DEFAULT_CAPS.telegram).toContain("write_full");
		expect(CHANNEL_DEFAULT_CAPS.telegram).toContain("admin");
	});

	test.each(["read", "write_basic", "write_full", "admin"] as DispatchCapability[])(
		"dispatches %s with no approval prompt",
		(capability) => {
			const decision = dispatch({ fromChannel: "telegram", capabilityRequired: capability });
			expect(decision.allowed).toBe(true);
			// The bug being fixed: `requiresApproval` on an ordinary action is
			// what surfaced as "it keeps asking me to approve".
			expect(approvalFlag(decision)).toBeFalsy();
		},
	);

	test("a token cannot be trimmed below the new ceiling by intersection", () => {
		expect(
			intersectChannelCaps("telegram", ["read", "write_basic", "write_full", "admin"]),
		).toEqual(["read", "write_basic", "write_full", "admin"]);
	});
});

describe("discord and browser are unchanged", () => {
	test.each(["discord", "browser"] as DaemonChannel[])(
		"%s still holds read + write_basic only",
		(channel) => {
			expect(CHANNEL_DEFAULT_CAPS[channel]).toEqual(["read", "write_basic"]);
		},
	);

	test.each(["discord", "browser"] as DaemonChannel[])(
		"%s still requires a second factor for write_full",
		(channel) => {
			const decision = dispatch({
				fromChannel: channel,
				capabilityRequired: "write_full",
				// Simulate a surface that claims more than its ceiling, so the test
				// exercises the lite-channel branch rather than the capability check.
				fromCapabilities: ["read", "write_basic", "write_full", "admin"],
			});
			expect(denied(decision).requiresApproval).toBe(true);
		},
	);

	test.each(["discord", "browser"] as DaemonChannel[])(
		"%s still requires a second factor for admin",
		(channel) => {
			const decision = dispatch({
				fromChannel: channel,
				capabilityRequired: "admin",
				fromCapabilities: ["read", "write_basic", "write_full", "admin"],
			});
			expect(denied(decision).requiresApproval).toBe(true);
		},
	);

	test("intersection still strips admin from a discord token that claims it", () => {
		expect(intersectChannelCaps("discord", ["read", "write_basic", "admin"])).toEqual([
			"read",
			"write_basic",
		]);
	});
});

describe("the approval mechanism is intact, not deleted", () => {
	test("a lite channel still produces a reachable requiresApproval decision", () => {
		const decision = dispatch({
			fromChannel: "discord",
			capabilityRequired: "admin",
			fromCapabilities: ["admin"],
		});
		expect(denied(decision).requiresApproval).toBe(true);
		expect(denied(decision).reason).toContain("second-factor approval");
	});

	test("capability checks still deny a surface that does not hold the capability", () => {
		// Widening telegram did not turn the gate off. A telegram surface whose
		// token was minted with read only still cannot dispatch admin.
		const decision = dispatch({
			fromChannel: "telegram",
			capabilityRequired: "admin",
			fromCapabilities: ["read"],
		});
		expect(denied(decision).reason).toContain("does not hold capability");
	});

	test("target channels that cannot host a capability still refuse it", () => {
		const decision = dispatch({
			fromChannel: "telegram",
			toChannel: "app",
			capabilityRequired: "admin",
		});
		expect(denied(decision).reason).toContain("does not host capability");
	});
});

describe("the telegram chat allowlist, which is what justifies the above", () => {
	const config = { authorizedChatIds: ["123456"], chatId: "123456" };

	test("accepts the allowlisted chat", () => {
		expect(isChatAuthorized(123456, config)).toBe(true);
	});

	test("rejects a foreign chat id", () => {
		expect(isChatAuthorized(999999, config)).toBe(false);
	});

	test("rejects a foreign chat id even when it is a prefix or suffix of the real one", () => {
		expect(isChatAuthorized(12345, config)).toBe(false);
		expect(isChatAuthorized(1234567, config)).toBe(false);
	});

	test("accepts every id on a multi-entry allowlist and nothing else", () => {
		const multi = { authorizedChatIds: ["111", "222"], chatId: "111" };
		expect(isChatAuthorized(111, multi)).toBe(true);
		expect(isChatAuthorized(222, multi)).toBe(true);
		expect(isChatAuthorized(333, multi)).toBe(false);
	});

	test("falls back to the single configured chat id when no allowlist is set", () => {
		const fallback = { chatId: "777" };
		expect(isChatAuthorized(777, fallback)).toBe(true);
		expect(isChatAuthorized(778, fallback)).toBe(false);
	});

	test("an empty allowlist does not mean allow-all", () => {
		// The dangerous shape of this bug is `allowlist.length === 0` being read
		// as "unconfigured, so permit". It falls through to the single-chat
		// check instead.
		const empty = { authorizedChatIds: [], chatId: "555" };
		expect(isChatAuthorized(555, empty)).toBe(true);
		expect(isChatAuthorized(556, empty)).toBe(false);
	});
});
