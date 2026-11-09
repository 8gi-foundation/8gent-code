/**
 * Two small rules for the chat's scroll position (pilot breaks 8 and 9).
 *
 * Pure, so they can be tested without a terminal.
 */

/** How far one PgUp or PgDn moves the chat, in messages. */
export const PAGE_MESSAGES = 5;

interface PagingKey {
	pageUp?: boolean;
	pageDown?: boolean;
	shift?: boolean;
	upArrow?: boolean;
	downArrow?: boolean;
}

/**
 * Messages to scroll back (positive) or forward (negative) for a key, or null
 * when the key is not a chat scroll key.
 *
 * Plain PgUp and PgDn page the chat in every layout (break 9: on a laptop
 * PgDn did nothing, because plain paging was keys-up only). An approval card
 * owns them while it is pending, because the card pages itself with the same
 * keys. Shift+arrows step one message; plain arrows belong to the input.
 */
export function pagingDelta(key: PagingKey, opts: { approvalPending: boolean }): number | null {
	if (key.pageUp && (key.shift || !opts.approvalPending)) return PAGE_MESSAGES;
	if (key.pageDown && (key.shift || !opts.approvalPending)) return -PAGE_MESSAGES;
	if (key.shift && key.upArrow) return 1;
	if (key.shift && key.downArrow) return -1;
	return null;
}

/**
 * Where the chat sits after new messages land.
 *
 * Sending a message always returns the person to the live edge (break 8:
 * after scrolling up, a submit left the view where it was and the reply
 * arrived out of sight). Otherwise a pinned chat follows the new messages, and
 * a chat the person scrolled up in stays locked on what they are reading.
 */
export function offsetAfterNewMessages(opts: {
	offset: number;
	pinned: boolean;
	added: readonly { role: string }[];
	total: number;
}): { offset: number; pinned: boolean } {
	if (opts.added.some((m) => m.role === "user")) return { offset: 0, pinned: true };
	if (opts.pinned) return { offset: 0, pinned: true };
	return {
		offset: Math.min(opts.offset + opts.added.length, Math.max(0, opts.total - 1)),
		pinned: false,
	};
}
