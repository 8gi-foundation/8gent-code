/**
 * Two small rules for the chat's scroll position (pilot breaks 8 and 9).
 *
 * Pure, so they can be tested without a terminal.
 */

interface PagingKey {
	pageUp?: boolean;
	pageDown?: boolean;
	shift?: boolean;
	upArrow?: boolean;
	downArrow?: boolean;
}

export type PagingAction = { page: 1 | -1 } | { step: number };

/**
 * What a key does to the chat scroll, or null when it is not a chat scroll key.
 *
 * Plain PgUp and PgDn page the chat in every layout (break 9: on a laptop
 * PgDn did nothing, because plain paging was keys-up only). An approval card
 * owns them while it is pending, because the card pages itself with the same
 * keys. Shift+arrows step one message; plain arrows belong to the input.
 * `page` is +1 back (up) and -1 forward (down); see `pageMessages` for how far.
 */
export function pagingAction(key: PagingKey, opts: { approvalPending: boolean }): PagingAction | null {
	if (key.pageUp && (key.shift || !opts.approvalPending)) return { page: 1 };
	if (key.pageDown && (key.shift || !opts.approvalPending)) return { page: -1 };
	if (key.shift && key.upArrow) return { step: 1 };
	if (key.shift && key.downArrow) return { step: -1 };
	return null;
}

/**
 * How many messages one page moves, measured in rows so a page is a screenful
 * whatever the messages weigh. Messages are whole units, so it takes as many as
 * fit in `pageRows`, and at least one: a 44-line message moves alone instead of
 * dragging four more past it and leaving the window half empty.
 *
 * `rows` is every message's height, oldest first. `offset` is how many messages
 * are held back from the bottom. dir +1 pages back, -1 forward. The result is
 * a signed message delta for the existing scroll clamp.
 */
export function pageMessages(opts: {
	rows: readonly number[];
	offset: number;
	dir: 1 | -1;
	pageRows: number;
}): number {
	const total = opts.rows.length;
	const end = total - opts.offset;
	let acc = 0;
	let count = 0;
	for (;;) {
		const idx = opts.dir === 1 ? end - 1 - count : end + count;
		if (idx < 0 || idx >= total) break;
		const r = Math.max(1, opts.rows[idx] ?? 1);
		if (count > 0 && acc + r > opts.pageRows) break;
		acc += r;
		count++;
	}
	return Math.max(1, count) * opts.dir;
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
