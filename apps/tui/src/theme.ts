/**
 * theme — single source of truth for all 8gent-code TUI color tokens.
 *
 * This IS the design token system. Every component must import from here.
 * Never hardcode hex values in components. If a color is missing, add it here.
 *
 * Mirrors the canonical brand palette from BRAND.md:
 *   Primary orange: #E8610A  |  Dark mode variant: #F07A28
 *   bg-0: #0A0908  |  text-primary: #FAF7F4  |  border: #2E2A26
 *
 * LIGHT/DARK MODE: the active palette is selected at module load. Override
 * with EIGHT_THEME=light or EIGHT_THEME=dark. Falls back to COLORFGBG
 * (set by macOS Terminal / iTerm2 / etc — `bg=15` is light, `bg=0` dark).
 * Defaults to dark when no signal is present.
 *
 * REAL BACKGROUND (#3754): index.tsx asks the terminal for its background
 * (OSC 11, theme/terminal-probe.ts) before Ink mounts and calls
 * applyTerminalBackground(), which re-fits `t` in place so every text tone
 * keeps 4.5:1 against the colour actually behind it.
 *
 * DESIGN SYSTEMS (#3754): `/theme` picks one of the indexed design systems
 * (theme/design-systems.ts), saved as "designSystem" in ~/.8gent/config.json.
 * No choice means this file's stock 8gent palette.
 *
 * The `inverted` semantic preserves brand identity: warm earth tones stay
 * dominant; we just flip the text/bg axis. Orange/teal/steel/red/green
 * keep their hue because they read on both backgrounds.
 */

import {
	CANONICAL_BG,
	DESIGN_SYSTEMS,
	designSystemPalette,
	fitPaletteToBackground,
	isLightBackground,
	readDesignSystemChoice,
} from "./theme/design-systems.js";

export type Mode = "dark" | "light";

function readConfigTheme(): Mode | "auto" | null {
	// Reading sync at module load is intentional - the active palette must be
	// frozen before any component imports `t`. Failures fall through silently.
	try {
		const fs = require("node:fs") as typeof import("node:fs");
		const path = require("node:path") as typeof import("node:path");
		const home = process.env.HOME ?? "";
		if (!home) return null;
		const cfgPath = path.join(home, ".8gent", "config.json");
		if (!fs.existsSync(cfgPath)) return null;
		const raw = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as { theme?: string };
		const v = (raw.theme ?? "").toLowerCase();
		if (v === "light" || v === "dark" || v === "auto") return v;
		return null;
	} catch {
		return null;
	}
}

function detectMode(): Mode {
	// 1. Hard env override (highest priority — useful for one-off launches)
	const override = (process.env.EIGHT_THEME ?? process.env["8GENT_THEME"] ?? "")
		.toLowerCase();
	if (override === "light") return "light";
	if (override === "dark") return "dark";

	// 2. Persisted setting in ~/.8gent/config.json (explicit user choice)
	const fromConfig = readConfigTheme();
	if (fromConfig === "light") return "light";
	if (fromConfig === "dark") return "dark";
	// "auto" or null → fall through to terminal detection

	// 3. COLORFGBG = "<fg>;<bg>"; bg=15 (white) → light terminal, bg=0/8 → dark.
	const fgbg = process.env.COLORFGBG ?? "";
	const parts = fgbg.split(";");
	const bg = parts[parts.length - 1];
	if (bg === "15" || bg === "7") return "light";

	// 4. Default
	return "dark";
}

const dark = {
	// Backgrounds (warm dark earth)
	bg:       "#0A0908",
	surface:  "#12100E",
	surface2: "#1C1A17",
	surface3: "#252220",


	// Text hierarchy (cream descending)
	textPrimary:   "#FAF7F4",
	textSecondary: "#C8C2BA",
	textTertiary:  "#8A8078",
	textDim:       "#5F5A55",

	// Aliases
	cream: "#FAF7F4",
	prose: "#E6DFD7",
	muted: "#8A8078",
	dim:   "#5F5A55",

	// Brand accent
	orange:    "#E8610A",
	orangeAlt: "#F07A28",
	orangeDim: "#8B3F12",

	// Border
	border:     "#2E2A26",
	cardBorder: "#2E2A26",
	// Frame: the one structural border and the key-cap brackets (HUD system,
	// #3238). 3.46:1 on bg, so an edge that means something clears 3:1.
	frame:      "#6B655F",

	// Section labels (WORKSPACE, AGENT ACTIVITY...): text-secondary, so
	// orange stays for state and focus (the active tab, DONE, the input,
	// the selection). 11.3:1 on bg.
	heading:  "#C8C2BA",

	// Semantic / UI
	teal:     "#7DA8A3",
	steel:    "#9DB5C8",
	steelDim: "#334958",
	// Danger: risk HIGH, N deny, MIC on, fail/error. 5.25:1 on bg (#3171;
	// #D63A24 was 4.25:1). Hue 8, same family as before.
	red:      "#E5503A",
	green:    "#47A639",
} as const;

// Light mode inverts the text/bg axis only. Brand orange and the
// teal/steel accents stay the same hue — their luminance contrast works on
// either bg. orange shifts to the deeper #C04E08 so it doesn't glare on
// cream. Border colors get bumped from invisible-on-cream to mid-warm-grey.
const light = {
	bg:       "#FAF7F4",
	surface:  "#E6DFD7",
	surface2: "#C8C2BA",
	surface3: "#8A8078",

	textPrimary:   "#0A0908",
	textSecondary: "#2E2A26",
	textTertiary:  "#5F5A55",
	textDim:       "#8A8078",

	cream: "#0A0908",     // primary text alias inverts too
	prose: "#1C1A17",
	muted: "#5F5A55",
	dim:   "#8A8078",

	orange:    "#C04E08",  // slightly deeper for cream-bg contrast
	orangeAlt: "#E8610A",
	orangeDim: "#8B3F12",

	border:     "#C8C2BA",
	cardBorder: "#8A8078",
	frame:      "#8A8078",  // 3.62:1 on cream

	heading:  "#2E2A26",   // text-secondary, 13.3:1 on cream

	teal:     "#3F7570",
	steel:    "#4F6E85",
	steelDim: "#1F2F3A",
	red:      "#A8231A",
	green:    "#2E7424",
} as const;

export type PaletteKey = keyof typeof dark;
/** A full TUI palette: every key the stock palettes have, as a hex string. */
export type Palette = Record<PaletteKey, string>;

/** Both palettes, for checks that must hold in either mode (contrast tests). */
export const palettes = { dark, light } as const;

/** Where the background the palette is fitted to came from. */
export type BackgroundSource = "terminal" | "assumed";

interface ThemeState {
	mode: Mode;
	/** The background text is measured against. */
	bg: string;
	bgSource: BackgroundSource;
	/** Design system id from the picker, or null for the stock 8gent theme. */
	designSystem: string | null;
}

/** True when the user forced a mode (env or config), so a probe cannot flip it. */
function forcedMode(): Mode | null {
	const override = (process.env.EIGHT_THEME ?? process.env["8GENT_THEME"] ?? "").toLowerCase();
	if (override === "light" || override === "dark") return override;
	const cfg = readConfigTheme();
	if (cfg === "light" || cfg === "dark") return cfg;
	return null;
}

function resolvePalette(state: ThemeState): Palette {
	const stock: Palette = { ...(state.mode === "light" ? light : dark) };
	if (state.designSystem) {
		const p = designSystemPalette(state.designSystem, state.bg);
		if (p) return p;
	}
	// The stock palette is used exactly as authored unless the terminal told us
	// its real background; then only lightness moves, to keep text at 4.5:1.
	return state.bgSource === "terminal" ? fitPaletteToBackground(stock, state.bg) : stock;
}

const initialMode: Mode = detectMode();
const state: ThemeState = {
	mode: initialMode,
	bg: CANONICAL_BG[initialMode],
	bgSource: "assumed",
	designSystem: readDesignSystemChoice(),
};

// `t` is one object for the life of the process, so every component that
// imported it sees a re-fit (terminal background, picker choice) in place.
const active: Palette = resolvePalette(state);

function refit(): void {
	Object.assign(active, resolvePalette(state));
	theme.mode = state.mode;
}

export const theme: { mode: Mode; color: Palette } = {
	mode: initialMode,
	color: active,
};

/**
 * Fit the palette to the background the terminal reported (OSC 11). The mode
 * follows the reported background unless EIGHT_THEME or config.json forced
 * one; a forced mode that disagrees with the terminal keeps its canonical
 * background, because that was an explicit choice.
 */
export function applyTerminalBackground(bgHex: string): void {
	const reported: Mode = isLightBackground(bgHex) ? "light" : "dark";
	const forced = forcedMode();
	if (forced && forced !== reported) return;
	state.mode = reported;
	state.bg = bgHex;
	state.bgSource = "terminal";
	refit();
}

/** Switch design system now (null = stock 8gent theme). Unknown ids are ignored. */
export function applyDesignSystem(id: string | null): void {
	state.designSystem = id;
	refit();
}

/** What the palette is currently fitted to, for /theme status lines. */
export function themeStatus(): Readonly<ThemeState> {
	return { ...state };
}

export interface ThemeChoice {
	/** "default" for the stock 8gent theme, else a design system id. */
	value: string;
	label: string;
	description: string;
	/** Primary, accent, user label and heading, as they will render here. */
	swatches: string[];
}

/**
 * The /theme picker rows: the stock 8gent theme first, then every indexed
 * design system. Swatches are the colours each choice will actually draw
 * against the current background, not the system's own light-page colours.
 */
export function themeChoices(): ThemeChoice[] {
	const swatch = (p: Palette) => [p.orange, p.orangeAlt, p.steel, p.heading];
	const stock: Palette = { ...(state.mode === "light" ? light : dark) };
	const stockFitted = state.bgSource === "terminal" ? fitPaletteToBackground(stock, state.bg) : stock;
	const rows: ThemeChoice[] = [
		{ value: "default", label: "8gent", description: "The stock 8gent theme", swatches: swatch(stockFitted) },
	];
	for (const ds of DESIGN_SYSTEMS) {
		const p = designSystemPalette(ds.id, state.bg);
		if (!p) continue;
		rows.push({ value: ds.id, label: ds.label, description: ds.mood === ds.style ? ds.mood : `${ds.mood}, ${ds.style}`, swatches: swatch(p) });
	}
	return rows;
}

// Shorthand for the most common pattern: `import { t } from "../theme.js"`
export const t = theme.color;
