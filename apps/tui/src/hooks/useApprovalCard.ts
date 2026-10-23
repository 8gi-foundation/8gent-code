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
import { createRef, useEffect, useLayoutEffect, useRef, useState } from "react";
import { currentPermissionMode } from "../../../../packages/permissions/permission-mode.js";
import {
	type TuiApprovalDecision,
	type TuiApprovalRequest,
	registerTuiApprovalHandler,
} from "../../../../packages/permissions/tui-approval-channel.js";
import { YOLO_QUESTION } from "../../../../packages/permissions/yolo-pref.js";
import { approvalReason } from "../lib/perm-modes-design.js";

export interface PendingApproval {
	target: string;
	/** Why the card came up, from the asking call's own permission mode (#3174). */
	reason?: string;
	/** Show the target in full, never cut (the request's `full`). */
	full?: boolean;
	/** The one-time yolo question: only Y and N answer it. */
	gate?: boolean;
	/** For a `full` card: the screen size it was last laid out whole at, and since when. */
	shownWholeAt?: string;
	shownSince?: number;
	resolve: (decision: TuiApprovalDecision) => void;
}

interface Sized {
	columns?: number;
	rows?: number;
}
const sizeOf = (out: Sized) => `${out.columns}x${out.rows}`;

/**
 * A `full` card takes no key until it has been laid out whole, and no key has
 * come, for this long: it has been painted and seen, and a key typed for the
 * chat as it appeared does not answer it.
 */
export const CARD_MIN_SHOW_MS = 500;

/** The box InlineApprovalPrompt draws a `full` card in. */
export const fullCardBox = createRef<DOMElement>();

/**
 * True when the card's own box has a size and lies inside every ancestor's box
 * and the screen (#3474). A 0-sized box (a `display: none` ancestor) is not shown.
 */
export function cardShowsAll(card: DOMElement | null | undefined, screen: Sized): boolean {
	const node = card?.yogaNode;
	if (!card || !node) return false;
	const w = node.getComputedWidth();
	const h = node.getComputedHeight();
	if (!(w > 0 && h > 0)) return false;
	let left = 0;
	let top = 0;
	let n: DOMElement = card;
	for (;;) {
		const y = n.yogaNode;
		if (!y) return false;
		left += y.getComputedLeft();
		top += y.getComputedTop();
		const parent = n.parentNode;
		const box = parent?.yogaNode
			? { w: parent.yogaNode.getComputedWidth(), h: parent.yogaNode.getComputedHeight() }
			: { w: screen.columns ?? 0, h: screen.rows ?? 0 };
		if (left < 0 || top < 0 || left + w > box.w || top + h > box.h) return false;
		if (!parent?.yogaNode) return true;
		n = parent;
	}
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
 * Offer this keypress (any key) to the pending card. Returns true when a card
 * key settled it. For a `full` card, once it has been laid out:
 * - its fit is checked again, because a sibling can grow and push it out of
 *   view without the card's own component re-rendering; if it no longer shows
 *   whole it is answered "unfit" and taken down, so nobody is left facing a
 *   card that takes no key;
 * - a card key is taken only when the card has been whole at this screen size
 *   and no key has come for CARD_MIN_SHOW_MS; any other keypress (still
 *   claimed if it is a card key, never passed on) restarts that wait.
 */
export function settleApprovalKey(input: string, key: KeyLike, screen?: Sized): boolean {
	const card = active;
	if (!card) return false;
	const decision = approvalDecisionForKey(input, key);
	if (card.full) {
		if (card.shownWholeAt === undefined || !screen) return false;
		if (!cardShowsAll(fullCardBox.current, screen)) {
			card.resolve("unfit");
			return false;
		}
		const now = Date.now();
		const ready =
			card.shownWholeAt === sizeOf(screen) &&
			now - (card.shownSince ?? Number.POSITIVE_INFINITY) >= CARD_MIN_SHOW_MS;
		if (!ready || !decision) {
			card.shownSince = now;
			return false;
		}
	}
	// The yolo question takes no key until it has been up CARD_MIN_SHOW_MS: a y
	// typed for the chat as it appeared must not turn yolo on. An early key is
	// claimed and ignored, and restarts the wait.
	if (card.gate) {
		const now = Date.now();
		if (now - (card.shownSince ?? 0) < CARD_MIN_SHOW_MS) {
			card.shownSince = now;
			return decision !== null;
		}
	}
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
 * A `full` card that is not laid out whole is answered "unfit" and taken
 * down, never left up clipped. The hook re-renders on resize itself, so the
 * check does not depend on the caller also using useViewport.
 */
export function useApprovalCard(
	onKey?: () => void,
	/**
	 * The one yes gate for yolo. `needed` is true until the user has answered
	 * once; `answer` saves it and applies it. Asked on the first card that would
	 * come up, never again.
	 */
	yolo?: { needed: () => boolean; answer: (yes: boolean) => void },
): PendingApproval | null {
	const yoloRef = useRef(yolo);
	yoloRef.current = yolo;
	const [pending, setPending] = useState<PendingApproval | null>(null);
	const { stdout } = useStdout();
	const [, setSize] = useState("");
	useEffect(() => {
		const onResize = () => setSize(sizeOf(stdout));
		stdout.on("resize", onResize);
		return () => {
			stdout.off("resize", onResize);
		};
	}, [stdout]);

	// Every commit, after Ink has laid out.
	useLayoutEffect(() => {
		const card = active;
		if (!card?.full || card !== pending) return;
		if (!cardShowsAll(fullCardBox.current, stdout)) return card.resolve("unfit");
		const size = sizeOf(stdout);
		if (card.shownWholeAt !== size) {
			card.shownWholeAt = size;
			card.shownSince = Date.now();
		}
	});

	useEffect(() => {
		// The yolo question, as a card of its own. Y saves yes, N saves no; any
		// other card key does nothing, and a card taken down unanswered (never
		// laid out) asks again next time.
		const askYolo = (): Promise<void> =>
			new Promise<void>((done) => {
				const card: PendingApproval = {
					target: YOLO_QUESTION,
					reason: "First time:",
					gate: true,
					shownSince: Date.now(),
					resolve: (decision) => {
						if (decision !== "approve" && decision !== "deny") return;
						yoloRef.current?.answer(decision === "approve");
						queueMicrotask(() => {
							if (active === card) active = null;
						});
						setPending((cur) => (cur === card ? null : cur));
						done();
					},
				};
				active = card;
				setPending(card);
			});
		// One card at a time: a request that arrives while a card (the yolo
		// question or a real one) is up waits its turn, so no card is ever
		// overwritten and left hanging, and there is never a second yolo card.
		// The first request into an idle queue raises its card synchronously.
		let turn: Promise<unknown> | null = null;
		const run = async (request: TuiApprovalRequest): Promise<TuiApprovalDecision> => {
			if (yoloRef.current?.needed()) await askYolo();
			return ask(request);
		};
		const handler = (request: TuiApprovalRequest): Promise<TuiApprovalDecision> => {
			const mine = turn ? turn.then(() => run(request)) : run(request);
			const tail: Promise<unknown> = mine
				.catch(() => {})
				.then(() => {
					if (turn === tail) turn = null;
				});
			turn = tail;
			return mine;
		};
		const ask = (request: TuiApprovalRequest): Promise<TuiApprovalDecision> =>
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
