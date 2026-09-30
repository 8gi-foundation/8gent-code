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

import { Text } from "ink";
import React from "react";
import { t } from "../theme.js";

/** Plain text of a cap, for width budgets and tests. */
export function keyCapText(cap: string, verb?: string): string {
	return `[${cap}]${verb ? ` ${verb}` : ""}`;
}

export function KeyCap({ cap, verb }: { cap: string; verb?: string }) {
	return (
		<Text>
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
