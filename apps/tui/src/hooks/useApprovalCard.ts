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

import { type DOMElement, useInput, useStdout } from "ink";
import { type RefObject, useEffect, useLayoutEffect, useState } from "react";
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
	/** Show the target in full, wrapped, never cut (the request's `full`). */
	full?: boolean;
	/** For a `full` card: the screen size it was last laid out whole at, if it was. */
	shownWholeAt?: string;
	resolve: (decision: TuiApprovalDecision) => void;
}

interface Sized {
	columns?: number;
	rows?: number;
}
const sizeOf = (out: Sized) => `${out.columns}x${out.rows}`;

/**
 * True when nothing in `column` (the chat column holding the card) is laid
 * out past its bottom edge, so the card and everything under it are on
 * screen. Ink wraps the card's text at the column's real width with real
 * display widths, so the heights read here are what is drawn (#3474).
 */
export function columnShowsAll(column: DOMElement | null | undefined): boolean {
	const node = column?.yogaNode;
	if (!node) return false;
	let bottom = 0;
	for (const child of column.childNodes) {
		const y = (child as DOMElement).yogaNode;
		if (y) bottom = Math.max(bottom, y.getComputedTop() + y.getComputedHeight());
	}
	return bottom <= node.getComputedHeight();
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
export function settleApprovalKey(input: string, key: KeyLike, screen?: Sized): boolean {
	const card = active;
	if (!card) return false;
	const decision = approvalDecisionForKey(input, key);
	if (!decision) return false;
	// A `full` card is approved only as last seen whole, at this screen size.
	// Not laid out yet, clipped, or resized since: Y is a no.
	const seenWhole = !card.full || (screen && card.shownWholeAt === sizeOf(screen));
	card.resolve(decision === "approve" && !seenWhole ? "deny" : decision);
	return true;
}

/** Test-only: drop any pending card. */
export function _resetApprovalCard(): void {
	active = null;
}

/**
 * Registers the TUI approval handler, holds the pending card for rendering,
 * and routes Y/N/E/S to it. `onKey` runs after a card key settles the card.
 * `column` is the box the card is drawn in: a `full` card that does not fit
 * it whole after layout is answered "unfit" and taken down, never left up
 * clipped (no column, no fit).
 */
export function useApprovalCard(
	onKey?: () => void,
	column?: RefObject<DOMElement | null>,
): PendingApproval | null {
	const [pending, setPending] = useState<PendingApproval | null>(null);
	const { stdout } = useStdout();

	// Every commit, after Ink has laid out (a resize re-renders too).
	useLayoutEffect(() => {
		const card = active;
		if (!card?.full || card !== pending) return;
		if (columnShowsAll(column?.current)) card.shownWholeAt = sizeOf(stdout);
		else card.resolve("unfit");
	});

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
					...(request.full ? { full: true } : {}),
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
		if (settleApprovalKey(input, key, stdout)) onKey?.();
	});

	return pending;
}
