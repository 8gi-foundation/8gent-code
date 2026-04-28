/**
 * 8gent Code - Amber-Safe Palette for Thinking Visualiser
 *
 * Brand colour is amber #E8610A. The TUI brand prohibition (CLAUDE.md #2)
 * bans hues 270-350 (purple/pink/violet). This module exposes a curated
 * palette that stays on the warm-to-cool axis and never crosses into the
 * banned range.
 *
 * Hex values are inspected by their HSL hue:
 *   30  - amber (brand)
 *   45  - gold
 *   60  - yellow
 *   90  - lime
 *   120 - green (only used for high-energy accents, not the dominant ramp)
 *   180 - cyan (info accent, used sparingly)
 *   210 - blue (ditto)
 *
 * No 270-350 hues anywhere. No raw "white"/"black"/"gray" - we use named
 * Ink colours where possible and only fall back to hex inside operator
 * colour maps.
 */

/** Primary amber gradient - low to high intensity. Reads as a heat map. */
export const AMBER_RAMP: readonly string[] = [
	"#3D1A05", // ember low
	"#5C2807",
	"#7A370A",
	"#99450C",
	"#B8540F",
	"#D66211",
	"#E8610A", // brand
	"#F08025",
	"#F39A41",
	"#F7B45C",
	"#FACE78",
	"#FDE894",
] as const;

/** Cool accents - cyan and blue. Used by cross-fade operators for contrast. */
export const COOL_ACCENTS: readonly string[] = [
	"#0D4A60",
	"#126A85",
	"#178AA9",
	"#1CAACC",
	"#21CAEF",
	"#5CDAEF",
] as const;

/** Idle / muted token. Subtle low-luminance amber for "asleep" state. */
export const MUTED_AMBER = "#3D1A05";

/** Brand amber. Use as fallback. */
export const BRAND_AMBER = "#E8610A";

/**
 * Sample the amber ramp by a 0..1 intensity. Values outside the range clamp.
 * Intensity 0 = ember low, 1 = warm cream highlight.
 */
export function sampleAmber(intensity: number): string {
	const i = Math.max(0, Math.min(1, intensity));
	const idx = Math.min(AMBER_RAMP.length - 1, Math.floor(i * AMBER_RAMP.length));
	return AMBER_RAMP[idx]!;
}

/**
 * Sample a hue-shifted colour from the amber-safe space. `hue` is 0..1 but
 * is mapped only into the amber-safe band (warm reds through cyan-blue at
 * the cool extreme). Never crosses into 270-350.
 *
 * Mapping (0..1 input -> degrees):
 *   0.0 - 0.5 : 30..60 (amber to yellow)
 *   0.5 - 0.7 : 60..120 (yellow to green)
 *   0.7 - 1.0 : 180..210 (cyan to blue, cool accent only)
 */
export function safeHueToColor(hue: number, intensity = 0.6, saturation = 0.7): string {
	const h = Math.max(0, Math.min(1, hue));
	let degrees: number;
	if (h < 0.5) {
		degrees = 30 + (h / 0.5) * 30; // 30..60
	} else if (h < 0.7) {
		degrees = 60 + ((h - 0.5) / 0.2) * 60; // 60..120
	} else {
		degrees = 180 + ((h - 0.7) / 0.3) * 30; // 180..210
	}
	const s = Math.max(0, Math.min(1, saturation));
	const l = Math.max(0.1, Math.min(0.85, intensity));
	return hslToHex(degrees, s * 100, l * 100);
}

/** HSL to hex helper. Pure function, no deps. */
function hslToHex(h: number, s: number, l: number): string {
	const sNorm = s / 100;
	const lNorm = l / 100;
	const c = (1 - Math.abs(2 * lNorm - 1)) * sNorm;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = lNorm - c / 2;
	let r = 0;
	let g = 0;
	let b = 0;
	if (h < 60) {
		r = c;
		g = x;
	} else if (h < 120) {
		r = x;
		g = c;
	} else if (h < 180) {
		g = c;
		b = x;
	} else if (h < 240) {
		g = x;
		b = c;
	} else if (h < 300) {
		r = x;
		b = c;
	} else {
		r = c;
		b = x;
	}
	const toHex = (v: number) =>
		Math.round((v + m) * 255)
			.toString(16)
			.padStart(2, "0");
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
