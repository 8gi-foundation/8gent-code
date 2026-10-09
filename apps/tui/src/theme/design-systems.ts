/**
 * Indexed design systems as TUI palettes (#3754).
 *
 * Source of truth: packages/design-systems/deck-themes/index.json, the
 * committed index of every design system in packages/design-systems (one entry
 * per system, generated from the design-systems DB by deck-themes.ts, #3591).
 * Nothing here is hand-typed colour: every palette is computed from that file.
 *
 * Mapping, one rule for every system:
 *   - The TUI paints text on the terminal's own background, so a palette is a
 *     function of (system, background). The background is the real one from
 *     the OSC 11 probe when the terminal answers, otherwise the canonical 8gent
 *     light or dark background.
 *   - Each TUI role takes its HUE and CHROMA from one design-system role
 *     (foreground, primary, accent, muted foreground, border...). Lightness is
 *     then moved, hue held, until the role clears its contrast target against
 *     that background, using design-compose's solver (WCAG 2.2 maths). A colour
 *     that already clears its target is kept exactly.
 *   - Every text role clears 4.5:1 (WCAG AA body text). Hierarchy comes from
 *     higher targets on the brighter roles. The frame clears 3:1 (non-text).
 *   - Danger red and success green keep the 8gent hues so their meaning does
 *     not change between themes.
 *   - Brand hue ban (BRAND.md, 270-350 rendered): a source hue that can render
 *     in the band snaps to the nearest legal OKLCH hue (design-compose
 *     LEGAL_HUES), and every output is re-checked on its rendered hue.
 *
 * Naming: systems named after a real company or product are never shown by
 * that name. They get a neutral label built from their style and primary hue,
 * so a public product carries no third-party mark. See NEUTRAL_LABEL_SOURCES.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	BANNED_HUE_MAX,
	BANNED_HUE_MIN,
	LEGAL_HUES,
	type Oklch,
	contrastRatio,
	fromHex,
	gamutMap,
	renderedHue,
	rgbToOklch,
	solveLegibleHex,
	toHex,
} from "../../../../packages/design-compose/index.js";
import index from "../../../../packages/design-systems/deck-themes/index.json" with {
	type: "json",
};
import type { Palette } from "../theme.js";

interface IndexEntry {
	name: string;
	mood: string;
	style: string;
	swatches: string[];
	colors: Record<string, string>;
}

export interface TuiDesignSystem {
	/** What the user types and what config.json stores. Never a brand name. */
	id: string;
	/** What the picker shows. Never a brand name. */
	label: string;
	mood: string;
	style: string;
	/** Preview row: background, primary, accent, from the index. */
	swatches: string[];
	/** The index entry name. Internal only, never rendered. */
	source: string;
}

/**
 * Index entries named after a real company, product or game. Their names are
 * third-party marks, so the TUI shows a neutral label instead. Listed in the
 * PR for 8DO and 8SO to decide whether they ship at all.
 */
export const NEUTRAL_LABEL_SOURCES: ReadonlySet<string> = new Set([
	"adidas",
	"apple",
	"chatgpt",
	"claude",
	"cursor",
	"doom-64",
	"e2b",
	"fynt",
	"google",
	"microsoft",
	"miro",
	"nike",
	"notion",
	"t3-chat",
	"teenage-engineering",
	"vercel",
]);

/** Ids the /theme command already uses for other things. */
const RESERVED_IDS = new Set(["light", "dark", "auto", "default", "8gent", "list", "pick"]);

export const CANONICAL_BG = { dark: "#0A0908", light: "#FAF7F4" } as const;

/** Every palette key that holds text, so must clear 4.5:1 on bg. */
export const TEXT_ROLES = [
	"textPrimary",
	"textSecondary",
	"textTertiary",
	"textDim",
	"cream",
	"prose",
	"muted",
	"dim",
	"heading",
	"orange",
	"orangeAlt",
	"teal",
	"steel",
	"red",
	"green",
] as const satisfies readonly (keyof Palette)[];

const AA = 4.5;
const NON_TEXT = 3;

// ---- colour helpers ------------------------------------------------------

const WHITE = fromHex("#ffffff");
const BLACK = fromHex("#000000");

export function contrastHex(a: string, b: string): number {
	return contrastRatio(fromHex(a), fromHex(b));
}

/** True when the background reads as light (dark text gives more contrast). */
export function isLightBackground(bgHex: string): boolean {
	const bg = fromHex(bgHex);
	return contrastRatio(bg, BLACK) > contrastRatio(bg, WHITE);
}

function isBannedRender(hex: string): boolean {
	const h = renderedHue(fromHex(hex));
	return h !== null && h >= BANNED_HUE_MIN && h <= BANNED_HUE_MAX;
}

function circularDistance(a: number, b: number): number {
	const d = Math.abs(a - b) % 360;
	return d > 180 ? 360 - d : d;
}

/** Snap an OKLCH hue to the nearest hue that never renders in the banned band. */
function legalHue(h: number): number {
	let best = LEGAL_HUES[0] ?? 0;
	for (const cand of LEGAL_HUES) {
		if (circularDistance(cand, h) < circularDistance(best, h)) best = cand;
	}
	// LEGAL_HUES is sampled every 5 degrees; a hue within half a step of a
	// legal sample sits between legal samples and is kept as it is.
	return circularDistance(best, h) <= 2.5 ? h : best;
}

function oklchOf(hex: string): Oklch {
	const c = rgbToOklch(fromHex(hex));
	return { l: c.l, c: c.c, h: Number.isFinite(c.h) ? c.h : 0 };
}

/**
 * Move `hex` in lightness only (hue and chroma held) until it clears `target`
 * against `bgHex`. A colour that already clears the target on the far side of
 * the background is returned unchanged. Falls back to the extreme (white or
 * black) when no lightness of that hue can reach the target.
 */
export function ensureContrast(hex: string, bgHex: string, target: number): string {
	const bg = fromHex(bgHex);
	const lightBg = isLightBackground(bgHex);
	const src = oklchOf(hex);
	const srcBanned = isBannedRender(hex);
	const sameSide = lightBg ? src.l < rgbToOklch(bg).l : src.l > rgbToOklch(bg).l;
	if (!srcBanned && sameSide && contrastRatio(fromHex(hex), bg) >= target) return hex;

	const hue = legalHue(src.h);
	const direction = lightBg ? "darker" : "lighter";
	for (const chroma of [src.c, src.c / 2, 0]) {
		const solved = solveLegibleHex(hue, () => chroma, bg, target, direction);
		if (solved && !isBannedRender(solved.hex)) return solved.hex;
	}
	return lightBg ? "#000000" : "#ffffff";
}

/**
 * `hex`'s hue solved to sit exactly `ratio` away from the background, for
 * roles that should be no louder than they need to be (surfaces, borders, the
 * frame). Chroma is capped at `maxChroma` so a surface stays a tint.
 */
function tintNear(hex: string, bgHex: string, ratio: number, maxChroma = 0.04): string {
	const bg = fromHex(bgHex);
	const src = oklchOf(hex);
	const hue = legalHue(src.h);
	const chroma = Math.min(src.c, maxChroma);
	const direction = isLightBackground(bgHex) ? "darker" : "lighter";
	const solved = solveLegibleHex(hue, () => chroma, bg, ratio, direction);
	const out = solved?.hex ?? toHex(gamutMap({ l: rgbToOklch(bg).l, c: 0, h: 0 }));
	return isBannedRender(out) ? toHex(gamutMap({ ...oklchOf(out), c: 0 })) : out;
}

function chromatic(hex: string | undefined): hex is string {
	return Boolean(hex) && oklchOf(hex as string).c >= 0.04;
}

// ---- default palette fitted to a real background -------------------------

/**
 * Keep every text role of `p` at 4.5:1 or better against `bgHex`, moving
 * lightness only. Used for the stock 8gent palette when the terminal reports
 * its real background, so brand orange stays orange and only gets lighter or
 * darker as needed.
 */
export function fitPaletteToBackground(p: Palette, bgHex: string): Palette {
	const out: Palette = { ...p, bg: bgHex };
	for (const role of TEXT_ROLES) out[role] = ensureContrast(p[role], bgHex, AA);
	out.frame = ensureContrast(p.frame, bgHex, NON_TEXT);
	out.border = fitChipTint(out.border, out.textPrimary, bgHex);
	return out;
}

/** The code chip puts textPrimary on `border`; keep that pair at 4.5:1 too. */
function fitChipTint(border: string, text: string, bgHex: string): string {
	if (contrastHex(text, border) >= AA) return border;
	for (const ratio of [1.4, 1.25, 1.12, 1.05, 1]) {
		const tint = ratio === 1 ? bgHex : tintNear(border, bgHex, ratio);
		if (contrastHex(text, tint) >= AA) return tint;
	}
	return bgHex;
}

// ---- design system -> palette -------------------------------------------

const DEFAULT_RED = "#E5503A";
const DEFAULT_GREEN = "#47A639";
const DEFAULT_TEAL = "#7DA8A3";
const DEFAULT_STEEL = "#9DB5C8";

/** Map one index entry onto every TUI palette key, against `bgHex`. */
export function paletteFromEntry(entry: IndexEntry, bgHex: string): Palette {
	const c = entry.colors;
	const fg = c.foreground;
	const primary = chromatic(c.primary) ? c.primary : chromatic(c.accent) ? c.accent : c.primary;
	const accent = chromatic(c.accent) ? c.accent : primary;
	const steelSrc = chromatic(c.accent) && c.accent !== primary ? c.accent : DEFAULT_STEEL;

	const textPrimary = ensureContrast(fg, bgHex, 15);
	const p: Palette = {
		bg: bgHex,
		surface: tintNear(c.card ?? c.background, bgHex, 1.08),
		surface2: tintNear(c.secondary ?? c.background, bgHex, 1.2),
		surface3: tintNear(c.muted ?? c.background, bgHex, 1.45),

		textPrimary,
		textSecondary: ensureContrast(c.secondaryForeground ?? fg, bgHex, 7.5),
		textTertiary: ensureContrast(c.mutedForeground ?? fg, bgHex, 5.2),
		textDim: ensureContrast(c.mutedForeground ?? fg, bgHex, AA),

		cream: textPrimary,
		prose: ensureContrast(fg, bgHex, 12),
		muted: ensureContrast(c.mutedForeground ?? fg, bgHex, 5.2),
		dim: ensureContrast(c.mutedForeground ?? fg, bgHex, AA),

		orange: ensureContrast(primary, bgHex, AA),
		orangeAlt: ensureContrast(accent, bgHex, AA),
		orangeDim: tintNear(primary, bgHex, NON_TEXT, 0.2),

		border: tintNear(c.border ?? fg, bgHex, 1.35),
		cardBorder: tintNear(c.border ?? fg, bgHex, 1.8),
		frame: tintNear(c.border ?? fg, bgHex, NON_TEXT + 0.2),

		heading: ensureContrast(c.secondaryForeground ?? fg, bgHex, 7.5),

		teal: ensureContrast(DEFAULT_TEAL, bgHex, AA),
		steel: ensureContrast(steelSrc, bgHex, AA),
		steelDim: tintNear(steelSrc, bgHex, 1.6),
		red: ensureContrast(DEFAULT_RED, bgHex, AA),
		green: ensureContrast(DEFAULT_GREEN, bgHex, AA),
	};
	p.border = fitChipTint(p.border, p.textPrimary, bgHex);
	return p;
}

// ---- catalogue -----------------------------------------------------------

const ENTRIES = index as IndexEntry[];

function titleCase(s: string): string {
	return s
		.split(/[-\s]+/)
		.filter(Boolean)
		.map((w) => w[0].toUpperCase() + w.slice(1))
		.join(" ");
}

/** A plain colour word for a hex, from its rendered hue. */
export function hueWord(hex: string): string {
	const h = renderedHue(fromHex(hex));
	if (h === null) return "Mono";
	if (h < 15 || h >= 345) return "Red";
	if (h < 40) return "Orange";
	if (h < 55) return "Amber";
	if (h < 70) return "Yellow";
	if (h < 160) return "Green";
	if (h < 185) return "Teal";
	if (h < 200) return "Cyan";
	if (h < 250) return "Blue";
	return "Indigo";
}

function slug(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

function buildCatalogue(): TuiDesignSystem[] {
	const out: TuiDesignSystem[] = [];
	const labels = new Set<string>();
	const ids = new Set<string>(RESERVED_IDS);
	// Real names first, so a neutral label can never take a real name's slot.
	const ordered = [...ENTRIES].sort(
		(a, b) => Number(NEUTRAL_LABEL_SOURCES.has(a.name)) - Number(NEUTRAL_LABEL_SOURCES.has(b.name)),
	);
	for (const e of ordered) {
		let label: string;
		if (!NEUTRAL_LABEL_SOURCES.has(e.name)) {
			label = titleCase(e.name);
		} else {
			const c = e.colors;
			const lead = chromatic(c.primary) ? c.primary : c.accent;
			const base = `${titleCase(e.style)} ${hueWord(lead)}`;
			const second =
				chromatic(c.accent) && hueWord(c.accent) !== hueWord(lead) ? ` ${hueWord(c.accent)}` : "";
			const candidates = [base, `${base}${second}`, `${base}${second} ${titleCase(e.mood)}`];
			label = candidates.find((l) => !labels.has(l)) ?? candidates[2];
			for (let n = 2; labels.has(label); n++) label = `${candidates[2]} ${n}`;
		}
		let id = NEUTRAL_LABEL_SOURCES.has(e.name) ? slug(label) : e.name;
		for (let n = 2; ids.has(id); n++) id = `${slug(label)}-${n}`;
		labels.add(label);
		ids.add(id);
		out.push({
			id,
			label,
			mood: e.mood,
			style: e.style,
			swatches: [...e.swatches],
			source: e.name,
		});
	}
	return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** Every indexed design system, as the picker lists it. */
export const DESIGN_SYSTEMS: readonly TuiDesignSystem[] = buildCatalogue();

export function findDesignSystem(id: string): TuiDesignSystem | undefined {
	const want = id.toLowerCase();
	return DESIGN_SYSTEMS.find((d) => d.id === want);
}

/** Palette for a catalogue id against a background, or null for an unknown id. */
export function designSystemPalette(id: string, bgHex: string): Palette | null {
	const ds = findDesignSystem(id);
	if (!ds) return null;
	const entry = ENTRIES.find((e) => e.name === ds.source);
	return entry ? paletteFromEntry(entry, bgHex) : null;
}

// ---- persistence (~/.8gent/config.json, key "designSystem") --------------

export function configPath(home = process.env.HOME ?? ""): string {
	return join(home, ".8gent", "config.json");
}

function readConfig(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** The saved design system id, or null for the stock 8gent theme. */
export function readDesignSystemChoice(path = configPath()): string | null {
	const v = readConfig(path).designSystem;
	return typeof v === "string" && findDesignSystem(v) ? v : null;
}

/** Save a choice (null clears it back to the 8gent theme). Keeps every other key. */
export function saveDesignSystemChoice(id: string | null, path = configPath()): void {
	if (id !== null && !findDesignSystem(id)) throw new Error(`Unknown design system: ${id}`);
	const raw = readConfig(path);
	if (id === null)
		raw.designSystem = undefined; // JSON.stringify drops it
	else raw.designSystem = id;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
}
