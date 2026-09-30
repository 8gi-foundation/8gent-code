/**
 * Contrast of the tones this HUD puts text in, in both palettes. WCAG AA
 * for normal text is 4.5:1. Orange is checked because it is the state and
 * focus colour; the heading tone because the rail labels moved to it; the
 * chip because inline code sits on a tint; red because it carries the danger
 * states (risk HIGH, N deny, MIC on) and was 4.25:1 on dark before #3171.
 */

import { describe, expect, test } from "bun:test";
import { palettes } from "../theme.js";

function luminance(hex: string): number {
	const [r, g, b] = [1, 3, 5].map((i) => {
		const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

describe("text contrast, both themes (4.5:1 or better)", () => {
	for (const [mode, p] of Object.entries(palettes)) {
		test(`${mode}: orange, headings, rail labels, prose and chips`, () => {
			const pairs: Array<[string, string, string]> = [
				["orange (tab, DONE settle, input, selection)", p.orange, p.bg],
				["section heading", p.heading, p.bg],
				["rail row label (textTertiary)", p.textTertiary, p.bg],
				["reply prose", p.prose, p.bg],
				["user text (textSecondary)", p.textSecondary, p.bg],
				["user label (steel)", p.steel, p.bg],
				["code chip text on its tint", p.textPrimary, p.border],
				["danger red (risk HIGH, N deny, MIC on, fail) #3171", p.red, p.bg],
			];
			for (const [name, fg, bg] of pairs) {
				const ratio = contrast(fg, bg);
				if (ratio < 4.5) throw new Error(`${mode} ${name}: ${ratio.toFixed(2)}:1`);
				expect(ratio).toBeGreaterThanOrEqual(4.5);
			}
		});
	}
});
