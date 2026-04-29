/**
 * theme — single source of truth for 8gent-code TUI color tokens.
 *
 * Mirrors the brand palette from 8gent.dev. New surfaces should import
 * `theme.color.*` instead of inlining hex values; legacy surfaces
 * (Header, command-input, message-list) still use Ink color names and
 * will be migrated over time.
 */

export const theme = {
	color: {
		bg: "#0A0908",
		surface: "#14110E",
		surface2: "#1B1713",
		cardBorder: "#5A7290",
		cream: "#FAF7F4",
		prose: "#E6DFD7",
		muted: "#8F8A84",
		dim: "#5F5A55",
		orange: "#E8610A",
		orangeDim: "#8B3F12",
		teal: "#7DA8A3",
		steel: "#9DB5C8",
		steelDim: "#334958",
		red: "#D63A24",
	},
} as const;

export type ThemeColor = keyof typeof theme.color;
