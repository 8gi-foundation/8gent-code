/**
 * KeyCap - the one way the HUD shows a key (HUD system, #3238).
 *
 *   [^P] palette     mode Planning [^Y]     [Space ▶❚]
 *
 * Car-stereo look: the brackets are the cap's edge, drawn in the frame
 * token; the key (and a transport symbol) in textSecondary; the verb after
 * the cap in textTertiary. Never bold. Brackets mean only this in the HUD,
 * so a bracketed thing is always a key you can press, with or without
 * colour.
 */

import { Box, Text } from "ink";
import React, { useRef } from "react";
import { type ClickSpan, useClickSpans, usePressedIn } from "../lib/click-targets.js";
import { cellWidth } from "../lib/header-layout.js";
import { keyBytes } from "../lib/key-bytes.js";
import { injectKeys } from "../lib/mouse-input.js";
import { t } from "../theme.js";

/** Plain text of a cap, for width budgets and tests. */
export function keyCapText(cap: string, verb?: string): string {
	return `[${cap}]${verb ? ` ${verb}` : ""}`;
}

export function KeyCap({
	cap,
	verb,
	pressed = false,
}: { cap: string; verb?: string; pressed?: boolean }) {
	// Pressed (mouse down on it, #3239): the cap draws in reverse video until
	// the release. Reverse video reads without colour too.
	return (
		<Text inverse={pressed}>
			<Text color={t.frame}>[</Text>
			<Text color={t.textSecondary}>{cap}</Text>
			<Text color={t.frame}>]</Text>
			{verb ? <Text color={t.textTertiary}> {verb}</Text> : null}
		</Text>
	);
}

/** Two spaces between caps in a row of hints. */
export const KEY_CAP_GAP = "  ";

/** Parse "^X plan" style hint strings into cap + verb. */
export function splitHint(hint: string): { cap: string; verb: string } {
	const i = hint.indexOf(" ");
	return i < 0 ? { cap: hint, verb: "" } : { cap: hint.slice(0, i), verb: hint.slice(i + 1) };
}

export interface CapSpec {
	cap: string;
	verb?: string;
	/** Cells before this cap; defaults to KEY_CAP_GAP for all but the first. */
	gap?: number;
}

/**
 * Each cap's whole drawn span, brackets and verb included, measured in
 * terminal cells (a wide glyph takes two). Caps whose key has no bytes are
 * not targets. `send` defaults to injecting the key; tests pass their own.
 */
export function keyCapSpans(
	caps: CapSpec[],
	idPrefix: string,
	send: (bytes: string) => void = injectKeys,
): ClickSpan[] {
	const spans: ClickSpan[] = [];
	let x = 0;
	caps.forEach((c, i) => {
		x += c.gap ?? (i > 0 ? KEY_CAP_GAP.length : 0);
		const w = cellWidth(keyCapText(c.cap, c.verb));
		const bytes = keyBytes(c.cap);
		if (bytes) spans.push({ id: `${idPrefix}:${c.cap}`, dx: x, w, action: () => send(bytes) });
		x += w;
	});
	return spans;
}

/**
 * A row of key caps that are also click targets (#3239): a click injects the
 * cap's key, so it does exactly what the key does. `z` lifts a surface's caps
 * (palette, approval card) over the HUD's.
 */
export function KeyCapRow({
	caps,
	idPrefix,
	z = 0,
}: { caps: CapSpec[]; idPrefix: string; z?: number }) {
	const ref = useRef(null);
	useClickSpans(ref, keyCapSpans(caps, idPrefix), z);
	const pressed = usePressedIn(`${idPrefix}:`);
	return (
		<Box ref={ref} flexShrink={0}>
			<Text>
				{caps.map((c, i) => (
					<Text key={c.cap}>
						{" ".repeat(c.gap ?? (i > 0 ? KEY_CAP_GAP.length : 0))}
						<KeyCap cap={c.cap} verb={c.verb} pressed={pressed === `${idPrefix}:${c.cap}`} />
					</Text>
				))}
			</Text>
		</Box>
	);
}
