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

import { useEffect, useRef, useSyncExternalStore } from "react";
import { cellWidth } from "./header-layout.js";
import type { MouseEvent } from "./mouse-input.js";

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

type Selection = { x0: number; y0: number; x1: number; y1: number };
let selection: Selection | null = null;
/** Reads the screen text for a copy; set by the app from Ink's last frame. */
let screenReader: (() => string) | null = null;
let copier: ((text: string) => void) | null = null;
const copiedListeners = new Set<(chars: number) => void>();

/** Hear about each copy, e.g. to say "copied 22 chars" in the footer. */
export function onCopied(fn: (chars: number) => void): () => void {
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
	selection = null;
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
	copy: ((text: string) => void) | null,
): void {
	screenReader = read;
	copier = copy;
}

/** The text a selection covers, row by row, trailing spaces trimmed. */
export function selectText(screen: string, sel: Selection): string {
	const lines = screen.split("\n");
	const [a, b] =
		sel.y0 < sel.y1 || (sel.y0 === sel.y1 && sel.x0 <= sel.x1)
			? [
					{ x: sel.x0, y: sel.y0 },
					{ x: sel.x1, y: sel.y1 },
				]
			: [
					{ x: sel.x1, y: sel.y1 },
					{ x: sel.x0, y: sel.y0 },
				];
	const out: string[] = [];
	for (let y = a.y; y <= b.y; y++) {
		const from = y === a.y ? a.x : 0;
		const to = y === b.y ? b.x + 1 : Number.POSITIVE_INFINITY;
		// Walk cells, not code points: a wide character takes two (Codex review #9).
		let col = 0;
		let row = "";
		for (const ch of lines[y] ?? "") {
			const w = cellWidth(ch);
			if (col + w > from && col < to) row += ch;
			col += w;
			if (col >= to) break;
		}
		out.push(row.trimEnd());
	}
	return out.join("\n");
}

/** Feed one mouse event. Returns what happened, for tests. */
export function handleMouse(e: MouseEvent): "click" | "press" | "cancel" | "copy" | null {
	if (e.kind === "press" && e.button === 0) {
		const t = hitTest(e.x, e.y);
		if (t) {
			setPressed(t.id);
			selection = null;
			return "press";
		}
		selection = { x0: e.x, y0: e.y, x1: e.x, y1: e.y };
		return null;
	}
	if (e.kind === "drag") {
		if (pressedId) {
			const t = hitTest(e.x, e.y);
			if (!t || t.id !== pressedId) setPressed(null);
			return null;
		}
		if (selection) selection = { ...selection, x1: e.x, y1: e.y };
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
		const sel = selection;
		selection = null;
		if (sel && (sel.x0 !== e.x || sel.y0 !== e.y) && screenReader && copier) {
			const text = selectText(screenReader(), { ...sel, x1: e.x, y1: e.y });
			if (text.trim().length > 0) {
				copier(text);
				for (const l of [...copiedListeners]) l([...text].length);
				return "copy";
			}
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
 * Register click spans for a box after every render, and drop them on
 * unmount. The spans are cheap to rebuild; the layout is read from Yoga,
 * so the rectangles follow the box wherever it lands.
 */
export function useClickSpans(ref: { current: unknown }, spans: ClickSpan[], z = 0): void {
	const ids = useRef<string[]>([]);
	useEffect(() => {
		const rect = ref.current ? absoluteRect(ref.current as NodeLike) : null;
		const next: string[] = [];
		if (rect) {
			for (const s of spans) {
				setTarget({
					id: s.id,
					x: rect.x + s.dx,
					y: rect.y + (s.dy ?? 0),
					w: s.w,
					h: s.h ?? 1,
					z,
					action: s.action,
				});
				next.push(s.id);
			}
		}
		for (const id of ids.current) if (!next.includes(id)) removeTarget(id);
		ids.current = next;
	});
	useEffect(
		() => () => {
			for (const id of ids.current) removeTarget(id);
			ids.current = [];
		},
		[],
	);
}
