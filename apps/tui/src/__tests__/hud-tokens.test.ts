/**
 * The HUD system's token contract (#3238, 8DO audit of a8abd5e3):
 * - textDim (2.92:1 dark, 3.62:1 light) is for lines and separators only,
 *   never for a word someone reads. On main the whole footer hint row,
 *   the tab numbers, "○ MIC" and the rail's "none" were drawn in it.
 * - orangeDim (2.67:1 dark) is never text.
 * - The frame token, the one edge colour, clears 3:1 in both palettes.
 * - No mounted HUD surface draws the Lil Eight badge or the context rail.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { palettes } from "../theme.js";

const COMPONENTS = path.join(import.meta.dir, "..", "components");
const HUD_FILES = [
	"HeaderBar.tsx",
	"StatusFooter.tsx",
	"BottomBar.tsx",
	"DjDeck.tsx",
	"ActivityRail.tsx",
	"LiveFocalStrip.tsx",
	"InlineApprovalPrompt.tsx",
	"CommandPalette.tsx",
	"PlanPanel.tsx",
	"TabBar.tsx",
	"KeyCap.tsx",
	"RailRow.tsx",
];

/** What a dim Text may hold: spaces, rule glyphs, or a rule/separator variable. */
const LINE_ONLY = /^(\s|│|─|\{FOOTER_SEPARATOR\}|\{rule\.(before|after)\})*$/;

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

describe("HUD token contract (#3238)", () => {
	for (const file of HUD_FILES) {
		test(`${file}: dim text is lines only, and no orangeDim text`, () => {
			const src = fs.readFileSync(path.join(COMPONENTS, file), "utf8");
			const dimTexts = [
				...src.matchAll(/<Text color=\{(?:t|ui)\.(?:dim|textDim)\}>([^<]*)<\/Text>/g),
			];
			for (const [, body] of dimTexts) expect(body).toMatch(LINE_ONLY);
			expect(src).not.toMatch(/<Text[^>]*color=\{t\.orangeDim\}/);
		});
	}

	for (const [mode, p] of Object.entries(palettes)) {
		test(`${mode}: the frame token clears 3:1, the key-cap verb clears 4.5:1`, () => {
			expect(contrast(p.frame, p.bg)).toBeGreaterThanOrEqual(3);
			expect(contrast(p.textTertiary, p.bg)).toBeGreaterThanOrEqual(4.5);
			expect(contrast(p.textSecondary, p.bg)).toBeGreaterThanOrEqual(4.5);
		});
	}

	test("the badge and the context rail are gone from the shell", () => {
		const app = fs.readFileSync(path.join(COMPONENTS, "..", "app.tsx"), "utf8");
		expect(app).not.toContain("LilEightBadge");
		expect(app).not.toContain("<ContextRail");
		expect(app).not.toContain("localFirst={true}");
	});
});
