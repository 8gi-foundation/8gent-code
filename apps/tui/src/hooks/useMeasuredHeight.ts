import { type DOMElement, measureElement } from "ink";
import { type RefObject, useEffect, useState } from "react";

/**
 * Height in rows of an Ink Box after layout, or null before the first
 * measurement. Re-measures after every render and only sets state when the
 * number changes, so it settles in one extra render.
 *
 * Why it exists (#3019): the chat row budget was guessed as
 * `viewport.height - constant`. The real chat area is whatever the flex
 * layout leaves after the header, tab strip, rails and input, which the
 * constant overestimated by up to 22 rows. MessageList then admitted more
 * rows than the box held, Ink shrank the items, and lines overprinted.
 */
export function useMeasuredHeight(ref: RefObject<DOMElement | null>): number | null {
	const [height, setHeight] = useState<number | null>(null);

	useEffect(() => {
		if (!ref.current) return;
		const measured = measureElement(ref.current).height;
		if (measured !== height) setHeight(measured);
	});

	return height;
}

/**
 * Rows MessageList may fill. The measured chat box wins; the old
 * viewport guess is only a fallback for the first frame, before layout.
 */
export function chatRowBudget(
	measured: number | null,
	viewportHeight: number,
	isProcessing: boolean,
): number {
	if (measured !== null && measured > 0) return Math.max(4, measured);
	return Math.max(6, viewportHeight - (isProcessing ? 18 : 10));
}
