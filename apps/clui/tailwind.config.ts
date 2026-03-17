/**
 * Tailwind CSS 4 configuration for 8gent CLUI.
 *
 * Design tokens are mapped from apps/tui/src/theme/tokens.ts and semantic.ts.
 * The 6 safe ANSI colors become CSS custom properties.
 * No gray, white, or black are used directly -- those come from
 * --text-primary and --bg-primary which swap between themes.
 */

import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // 8gent brand colors (mapped from TUI tokens)
        "8-red": "var(--color-red)",
        "8-green": "var(--color-green)",
        "8-yellow": "var(--color-yellow)",
        "8-blue": "var(--color-blue)",
        "8-magenta": "var(--color-magenta)",
        "8-cyan": "var(--color-cyan)",

        // Semantic aliases (mapped from TUI semantic.ts)
        accent: "var(--text-accent)",
        brand: "var(--text-brand)",
        success: "var(--text-success)",
        warning: "var(--text-warning)",
        danger: "var(--text-danger)",
        info: "var(--text-info)",
        muted: "var(--text-muted)",

        // Surface colors
        "surface-primary": "var(--bg-primary)",
        "surface-secondary": "var(--bg-secondary)",
        "surface-elevated": "var(--bg-elevated)",

        // Text colors
        "text-primary": "var(--text-primary)",
        "text-secondary": "var(--text-secondary)",
      },
      borderColor: {
        DEFAULT: "var(--border-default)",
        accent: "var(--border-accent)",
        subtle: "var(--border-subtle)",
        danger: "var(--border-danger)",
        success: "var(--border-success)",
      },
      spacing: {
        // Mapped from TUI space tokens
        "8-xs": "0.25rem", // 1 terminal col ~ 4px
        "8-sm": "0.5rem", // 2 terminal cols ~ 8px
        "8-md": "1rem", // 4 terminal cols ~ 16px
      },
      maxWidth: {
        "8-content": "40rem", // ~80 chars (TUI size.lg)
        "8-sidebar": "20rem", // ~40 chars (TUI size.sm)
      },
      fontFamily: {
        mono: [
          "Berkeley Mono",
          "JetBrains Mono",
          "Fira Code",
          "Menlo",
          "Monaco",
          "monospace",
        ],
      },
      animation: {
        "pulse-slow": "pulse 3s ease-in-out infinite",
        "fade-in": "fadeIn 200ms ease-out",
        "slide-up": "slideUp 200ms ease-out",
        ripple: "ripple 2s ease-in-out infinite",
      },
      keyframes: {
        fadeIn: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        slideUp: {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        ripple: {
          "0%, 100%": { transform: "scale(1)", opacity: "0.5" },
          "50%": { transform: "scale(1.5)", opacity: "0" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
