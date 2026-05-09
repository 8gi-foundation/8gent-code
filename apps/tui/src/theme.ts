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
 * The `inverted` semantic preserves brand identity: warm earth tones stay
 * dominant; we just flip the text/bg axis. Orange/teal/steel/red/green
 * keep their hue because they read on both backgrounds.
 */

type Mode = "dark" | "light";

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

	// Semantic / UI
	teal:     "#7DA8A3",
	steel:    "#9DB5C8",
	steelDim: "#334958",
	red:      "#D63A24",
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

	teal:     "#3F7570",
	steel:    "#4F6E85",
	steelDim: "#1F2F3A",
	red:      "#A8231A",
	green:    "#2E7424",
} as const;

const mode: Mode = detectMode();

export const theme = {
	mode,
	color: mode === "light" ? light : dark,
} as const;

type ThemeColor = keyof typeof dark;

// Shorthand for the most common pattern: `import { t } from "../theme.js"`
export const t = theme.color;
