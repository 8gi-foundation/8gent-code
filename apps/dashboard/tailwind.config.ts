import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // 8gent design tokens
        "8gent": {
          bg: "var(--8gent-bg)",
          "bg-elevated": "var(--8gent-bg-elevated)",
          "bg-hover": "var(--8gent-bg-hover)",
          border: "var(--8gent-border)",
          "border-focus": "var(--8gent-border-focus)",
          text: "var(--8gent-text)",
          "text-secondary": "var(--8gent-text-secondary)",
          "text-muted": "var(--8gent-text-muted)",
          accent: "var(--8gent-accent)",
          "accent-hover": "var(--8gent-accent-hover)",
          success: "var(--8gent-success)",
          warning: "var(--8gent-warning)",
          error: "var(--8gent-error)",
        },
      },
      fontFamily: {
        mono: ["var(--font-geist-mono)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
