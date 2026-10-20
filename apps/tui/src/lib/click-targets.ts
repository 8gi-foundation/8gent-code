/**
 * Click targets for the HUD (#3239). A click does exactly what the key does.
 *
 * Components register rectangles (0-based cells, the same grid as the SGR
 * report) with the action their key runs. A press on a target marks it
 * pressed, so it can draw in reverse video; the release on the same target
 * runs the action, a release anywhere else cancels. A drag that starts off
 * every target selects text instead: on release the text under it is
 * copied with OSC 52 and "copied N chars" shows in the footer, the way the
 * TUI James uses does it. There is no hover: the key cap's brackets are the
 * affordance at rest.
 */

import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { MouseEvent } from "./mouse-input.js";
import { type SelRange, TextSelection, extractText } from "./text-selection.js";

export interface ClickTarget {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
	/** Higher wins where targets overlap: surfaces (palette, card) sit over the HUD. */
	z: number;
	action: () => void;
}

const targets = new Map<string, ClickTarget>();
let pressedId: string | null = null;
const pressedListeners = new Set<() => void>();

/** Reads the screen text for a copy; set by the app from Ink's last frame. */
let screenReader: (() => string) | null = null;
let copier: ((text: string) => unknown) | null = null;
const copiedListeners = new Set<(chars: number, ok: boolean) => void>();
const selection = new TextSelection(() => screenReader?.() ?? "");
const selectionListeners = new Set<(range: SelRange | null) => void>();

/** Hear when the highlighted range changes (null: cleared), to redraw it. */
export function onSelectionChange(fn: (range: SelRange | null) => void): () => void {
	selectionListeners.add(fn);
	return () => {
		selectionListeners.delete(fn);
	};
}

function selectionChanged(): void {
	for (const l of [...selectionListeners]) l(selection.range);
}

/** Escape: drop the highlight. True when there was one to drop. */
export function clearSelection(): boolean {
	const had = selection.clear();
	if (had) selectionChanged();
	return had;
}

/** Hear about each copy, e.g. to say "copied 22 chars" in the footer. */
export function onCopied(fn: (chars: number, ok: boolean) => void): () => void {
	copiedListeners.add(fn);
	return () => {
		copiedListeners.delete(fn);
	};
}

export function setTarget(t: ClickTarget): void {
	targets.set(t.id, t);
}

export function removeTarget(id: string): void {
	targets.delete(id);
	if (pressedId === id) setPressed(null);
}

export function clearTargets(): void {
	targets.clear();
	setPressed(null);
	selection.reset();
	selectionChanged();
}

/** The topmost target under a cell, or undefined. */
export function hitTest(x: number, y: number): ClickTarget | undefined {
	let best: ClickTarget | undefined;
	for (const t of targets.values()) {
		if (x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h) {
			if (!best || t.z >= best.z) best = t;
		}
	}
	return best;
}

function setPressed(id: string | null): void {
	if (pressedId === id) return;
	pressedId = id;
	for (const l of [...pressedListeners]) l();
}

export function currentPressed(): string | null {
	return pressedId;
}

/** Where the text for a copy comes from, and where it goes. */
export function setSelectionIO(
	read: (() => string) | null,
	copy: ((text: string) => unknown) | null,
): void {
	screenReader = read;
	copier = copy;
}

/** The text a selection covers, row by row, trailing spaces trimmed. */
export const selectText = extractText;

/** Feed one mouse event. Returns what happened, for tests. */
export function handleMouse(e: MouseEvent): "click" | "press" | "cancel" | "copy" | null {
	if (e.kind === "press" && e.button === 0) {
		const t = hitTest(e.x, e.y);
		if (t) {
			setPressed(t.id);
			clearSelection();
			return "press";
		}
		const had = selection.range !== null;
		selection.press(e.x, e.y);
		if (had || selection.range) selectionChanged();
		return null;
	}
	if (e.kind === "drag") {
		if (pressedId) {
			const t = hitTest(e.x, e.y);
			if (!t || t.id !== pressedId) setPressed(null);
			return null;
		}
		const before = selection.range;
		selection.drag(e.x, e.y);
		const after = selection.range;
		if (after && (!before || before.x1 !== after.x1 || before.y1 !== after.y1)) selectionChanged();
		return null;
	}
	if (e.kind === "release") {
		const id = pressedId;
		setPressed(null);
		if (id) {
			const t = hitTest(e.x, e.y);
			if (t && t.id === id) {
				t.action();
				return "click";
			}
			return "cancel";
		}
		const r = selection.release(e.x, e.y);
		selectionChanged();
		if (r.kind === "copy" && copier) {
			const res = copier(r.text);
			// Too long for OSC 52 and no local command took it: nothing was copied.
			const out = res as { osc52?: boolean; native?: string | null } | null | undefined;
			const ok = typeof out !== "object" || out === null || out.osc52 === true || !!out.native;
			for (const l of [...copiedListeners]) l([...r.text].length, ok);
			return "copy";
		}
		return null;
	}
	return null;
}

/** Re-renders only when the pressed target changes to or from `id`. */
export function usePressed(id: string): boolean {
	return useSyncExternalStore(
		(cb) => {
			pressedListeners.add(cb);
			return () => {
				pressedListeners.delete(cb);
			};
		},
		() => pressedId === id,
		() => false,
	);
}

/** Any id in `ids` pressed? One subscription for a row of caps. */
export function usePressedIn(prefix: string): string | null {
	return useSyncExternalStore(
		(cb) => {
			pressedListeners.add(cb);
			return () => {
				pressedListeners.delete(cb);
			};
		},
		() => (pressedId?.startsWith(prefix) ? pressedId : null),
		() => null,
	);
}

/** A span inside a box: offsets in cells from the box's top-left. */
export interface ClickSpan {
	id: string;
	dx: number;
	dy?: number;
	w: number;
	h?: number;
	/** A span whose neighbours never claim the gaps beside it: a miss must not fire it (quit). */
	tight?: boolean;
	action: () => void;
}

interface YogaLike {
	getComputedLeft(): number;
	getComputedTop(): number;
	getComputedWidth(): number;
	getComputedHeight(): number;
}
interface NodeLike {
	yogaNode?: YogaLike;
	parentNode?: NodeLike | null;
}

/** A box's absolute cell rectangle, from Ink's computed layout. */
export function absoluteRect(
	node: NodeLike,
): { x: number; y: number; w: number; h: number } | null {
	const own = node.yogaNode;
	if (!own) return null;
	let x = 0;
	let y = 0;
	let n: NodeLike | null | undefined = node;
	while (n) {
		if (n.yogaNode) {
			x += n.yogaNode.getComputedLeft();
			y += n.yogaNode.getComputedTop();
		}
		n = n.parentNode;
	}
	return { x, y, w: own.getComputedWidth(), h: own.getComputedHeight() };
}

/**
 * The widest gap two neighbouring targets share. Every row of targets in the
 * HUD is separated by at most three cells (two between key caps, three
 * between tabs, " │ " between footer segments), so a gap this size or less
 * is padding. A wider gap holds something that is not a target (a footer
 * segment with no key) and stays nobody's.
 */
export const MAX_SHARED_GAP = 3;

/**
 * Close the dead cells between neighbouring spans on the same row, so a
 * click just outside a cap's bracket still lands on a cap (James,
 * 2026-10-02: clicks only worked near the middle). The left span takes the
 * floor of the gap, the right span the ceiling; an overlap is trimmed so
 * no cell belongs to two spans. Pure; returns new spans in input order.
 */
export function closeGaps(spans: ClickSpan[], maxGap = MAX_SHARED_GAP): ClickSpan[] {
	const out = spans.map((s) => ({ ...s }));
	const rowKey = (s: ClickSpan) => `${s.dy ?? 0}:${s.h ?? 1}`;
	const rows = new Map<string, ClickSpan[]>();
	for (const s of out) {
		const k = rowKey(s);
		rows.set(k, [...(rows.get(k) ?? []), s]);
	}
	for (const row of rows.values()) {
		row.sort((a, b) => a.dx - b.dx);
		for (let i = 0; i + 1 < row.length; i++) {
			const a = row[i] as ClickSpan;
			const b = row[i + 1] as ClickSpan;
			const gap = b.dx - (a.dx + a.w);
			if (gap < 0) {
				a.w = Math.max(0, b.dx - a.dx);
			} else if (gap > 0 && gap <= maxGap && !a.tight && !b.tight) {
				const left = Math.floor(gap / 2);
				const right = gap - left;
				a.w += left;
				b.dx -= right;
				b.w += right;
			}
		}
	}
	return out;
}

/**
 * Register spans for a box at `rect`: gaps up to `maxGap` closed, each span
 * clipped to the box's width so a truncated row never claims cells it did
 * not draw. `maxGap` 0 keeps every gap dead, for rows where a miss must do
 * nothing (the approval card). Returns the ids registered.
 */
export function placeSpans(
	rect: { x: number; y: number; w: number; h: number },
	spans: ClickSpan[],
	z = 0,
	maxGap = MAX_SHARED_GAP,
): string[] {
	const ids: string[] = [];
	for (const s of closeGaps(spans, maxGap)) {
		const w = Math.min(s.w, rect.w - s.dx);
		if (w <= 0 || s.dx < 0) continue;
		setTarget({
			id: s.id,
			x: rect.x + s.dx,
			y: rect.y + (s.dy ?? 0),
			w,
			h: s.h ?? 1,
			z,
			action: s.action,
		});
		ids.push(s.id);
	}
	return ids;
}

/**
 * Register click spans for a box after every render, and drop them on
 * unmount. The spans are cheap to rebuild; the layout is read from Yoga,
 * so the rectangles follow the box wherever it lands.
 *
 * A layout effect, not a passive one: Ink computes Yoga layout in its
 * commit, before layout effects run, and paints in that same commit. A
 * passive effect runs later, so a cap could be on screen with no target
 * under it, and a click in that window hit nothing (James, 2026-10-02).
 */
export function useClickSpans(
	ref: { current: unknown },
	spans: ClickSpan[],
	z = 0,
	maxGap = MAX_SHARED_GAP,
): void {
	const ids = useRef<string[]>([]);
	useLayoutEffect(() => {
		const rect = ref.current ? absoluteRect(ref.current as NodeLike) : null;
		const next: string[] = rect ? placeSpans(rect, spans, z, maxGap) : [];
		for (const id of ids.current) if (!next.includes(id)) removeTarget(id);
		ids.current = next;
	});
	useLayoutEffect(
		() => () => {
			for (const id of ids.current) removeTarget(id);
			ids.current = [];
		},
		[],
	);
}
