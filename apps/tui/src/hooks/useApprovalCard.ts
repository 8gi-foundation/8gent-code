/**
 * Inline approval card: state, handler registration and key routing.
 *
 * While a card is pending, Y/N/E/S belong to the card and never to the chat
 * input (#3055). Two things made the keypress leak before:
 *
 * 1. Ink hands every keypress to every active `useInput` listener. The chat
 *    input (BufferedTextInput) is always active, so a Y that settled the card
 *    was also typed into the input ("❯ y").
 * 2. The app-level intercept read `approvalPending` from its render closure.
 *    Ink re-binds useInput handlers only after React flushes passive effects,
 *    so a key that arrives right after the card is raised (a fast person, a
 *    pilot, tmux send-keys) saw the old `null`, did not settle the card, and
 *    fell through to the input. The card stayed up and needed a second Y.
 *
 * The fix keeps the pending card in module state that is set synchronously
 * when the approval request arrives, before any render. Every listener asks
 * the same question for the same keypress: `isApprovalKeyClaimed`. The card
 * is cleared on a microtask after it settles, so a listener that runs later
 * in the same keypress dispatch still sees the key as claimed and ignores it.
 */

import { useInput } from "ink";
import { useEffect, useState } from "react";
import {
	registerTuiApprovalHandler,
	type TuiApprovalDecision,
	type TuiApprovalRequest,
} from "../../../../packages/permissions/tui-approval-channel.js";
import { currentPermissionMode } from "../../../../packages/permissions/permission-mode.js";
import { approvalReason } from "../lib/perm-modes-design.js";

export interface PendingApproval {
	target: string;
	/** Why the card came up, from the asking call's own permission mode (#3174). */
	reason?: string;
	resolve: (decision: TuiApprovalDecision) => void;
}

interface KeyLike {
	ctrl?: boolean;
	meta?: boolean;
}

const CARD_KEYS: Record<string, TuiApprovalDecision> = {
	y: "approve",
	n: "deny",
	e: "edit",
	s: "skip",
};

let active: PendingApproval | null = null;

/** The card decision a keypress maps to, or null if it is not a card key. */
export function approvalDecisionForKey(input: string, key: KeyLike): TuiApprovalDecision | null {
	if (key.ctrl || key.meta) return null;
	return CARD_KEYS[(input || "").toLowerCase()] ?? null;
}

/** True when a card is pending and this keypress is one of its keys. */
export function isApprovalKeyClaimed(input: string, key: KeyLike): boolean {
	return active !== null && approvalDecisionForKey(input, key) !== null;
}

/**
 * Settle the pending card with this keypress. Returns true when the key was
 * a card key (the caller must not act on it further). Idempotent within one
 * keypress dispatch: the card resolves once.
 */
export function settleApprovalKey(input: string, key: KeyLike): boolean {
	const card = active;
	if (!card) return false;
	const decision = approvalDecisionForKey(input, key);
	if (!decision) return false;
	card.resolve(decision);
	return true;
}

/** Test-only: drop any pending card. */
export function _resetApprovalCard(): void {
	active = null;
}

/**
 * Registers the TUI approval handler, holds the pending card for rendering,
 * and routes Y/N/E/S to it. `onKey` runs after a card key settles the card.
 */
export function useApprovalCard(onKey?: () => void): PendingApproval | null {
	const [pending, setPending] = useState<PendingApproval | null>(null);

	useEffect(() => {
		const handler = (request: TuiApprovalRequest): Promise<TuiApprovalDecision> =>
			new Promise<TuiApprovalDecision>((resolvePromise) => {
				const target = request.command || request.action || "pending tool call";
				let settled = false;
				// The request arrives inside the asking tool call, so its
				// permission mode is the call's own, not the focused tab's.
				const reason = approvalReason(currentPermissionMode());
				const card: PendingApproval = {
					target,
					...(reason ? { reason } : {}),
					resolve: (decision) => {
						if (settled) return;
						settled = true;
						// Keep claiming keys until this keypress has reached every
						// listener, then free the keyboard.
						queueMicrotask(() => {
							if (active === card) active = null;
						});
						setPending((cur) => (cur === card ? null : cur));
						resolvePromise(decision);
					},
				};
				active = card;
				setPending(card);
			});
		registerTuiApprovalHandler(handler);
		return () => {
			registerTuiApprovalHandler(null);
			active = null;
		};
	}, []);

	useInput((input, key) => {
		if (settleApprovalKey(input, key)) onKey?.();
	});

	return pending;
}
