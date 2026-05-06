/**
 * theme — single source of truth for all 8gent-code TUI color tokens.
 *
 * Two layers, both required:
 *   1. `palette` — raw earth-tone primitives (the only place hex literals live)
 *   2. `theme.color` — semantic tokens; every value MUST reference a palette
 *      primitive. Never inline a hex here, and never inline one in a component.
 *
 * Mirrors the canonical brand palette from BRAND.md:
 *   Primary orange: #E8610A  |  Dark mode variant: #F07A28
 *   bg-0: #0A0908  |  text-primary: #FAF7F4  |  border: #2E2A26
 */

// ── Layer 1: raw palette primitives ────────────────────────────────────
// Earth-tone ramps. These are the only hex literals in the design system.
const palette = {
	// Warm neutrals (bg → text)
	earth0: "#0A0908",  // bg-0          deepest
	earth1: "#12100E",  // bg-1
	earth2: "#1C1A17",  // bg-2
	earth3: "#252220",  // bg-3
	earth4: "#2E2A26",  // subtle border (matches BRAND.md `border`)
	earth5: "#4A453F",  // visible border (cards, chips)
	earth6: "#5F5A55",  // textDim
	earth7: "#8A8078",  // textTertiary
	earth8: "#C8C2BA",  // textSecondary
	earth9: "#E6DFD7",  // prose
	earth10: "#FAF7F4", // text-primary (cream)

	// Brand orange
	orange500: "#E8610A",
	orange400: "#F07A28",
	orange700: "#8B3F12",

	// Cool accents (semantic only — keep usage minimal vs warm earth tones)
	teal500:    "#7DA8A3",
	steel500:   "#9DB5C8",
	steel800:   "#334958",

	// Status
	red500:   "#D63A24",
	green500: "#47A639",
} as const;

// ── Layer 2: semantic tokens (compose from palette only) ───────────────
export const theme = {
	color: {
		// Backgrounds (dark mode default)
		bg:       palette.earth0,
		surface:  palette.earth1,
		surface2: palette.earth2,
		surface3: palette.earth3,

		// Text hierarchy
		textPrimary:   palette.earth10,
		textSecondary: palette.earth8,
		textTertiary:  palette.earth7,
		textDim:       palette.earth6,

		// Aliases used by legacy code (same values, different names)
		cream: palette.earth10,
		prose: palette.earth9,
		muted: palette.earth7,
		dim:   palette.earth6,

		// Brand accent
		orange:    palette.orange500,
		orangeAlt: palette.orange400,
		orangeDim: palette.orange700,

		// Border ramp
		border:     palette.earth4,  // page-level frames (subtle)
		cardBorder: palette.earth5,  // HUD card cells (visible against bg)

		// Semantic / UI colors (kept warm where possible)
		teal:     palette.teal500,
		steel:    palette.steel500,
		steelDim: palette.steel800,
		red:      palette.red500,
		green:    palette.green500,
	},
} as const;

export type ThemeColor = keyof typeof theme.color;

// Shorthand for the most common pattern: `import { t } from "../theme.js"`
export const t = theme.color;
