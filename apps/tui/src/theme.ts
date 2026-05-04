/**
 * theme — single source of truth for all 8gent-code TUI color tokens.
 *
 * This IS the design token system. Every component must import from here.
 * Never hardcode hex values in components. If a color is missing, add it here.
 *
 * Mirrors the canonical brand palette from BRAND.md:
 *   Primary orange: #E8610A  |  Dark mode variant: #F07A28
 *   bg-0: #0A0908  |  text-primary: #FAF7F4  |  border: #2E2A26
 */

export const theme = {
	color: {
		// Backgrounds (dark mode default)
		bg:       "#0A0908",  // bg-0
		surface:  "#12100E",  // bg-1
		surface2: "#1C1A17",  // bg-2
		surface3: "#252220",  // bg-3

		// Text hierarchy
		textPrimary:   "#FAF7F4",  // text-primary   (cream)
		textSecondary: "#C8C2BA",  // text-secondary
		textTertiary:  "#8A8078",  // text-tertiary
		textDim:       "#5F5A55",  // below tertiary

		// Aliases used by legacy code (same values, different names)
		cream: "#FAF7F4",
		prose: "#E6DFD7",
		muted: "#8A8078",
		dim:   "#5F5A55",

		// Brand accent
		orange:    "#E8610A",  // primary orange (dark contexts)
		orangeAlt: "#F07A28",  // dark mode variant
		orangeDim: "#8B3F12",  // muted orange for backgrounds

		// Border
		border: "#2E2A26",

		// Semantic / UI colors (kept warm where possible)
		teal:     "#7DA8A3",
		steel:    "#9DB5C8",
		steelDim: "#334958",
		red:      "#D63A24",
		green:    "#47A639",
	},
} as const;

export type ThemeColor = keyof typeof theme.color;

// Shorthand for the most common pattern: `import { t } from "../theme.js"`
export const t = theme.color;
