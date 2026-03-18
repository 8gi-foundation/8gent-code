/** Design tokens for 8gent video demos */
export const colors = {
  bg: "#0a0a0f",
  bgCard: "#12121a",
  bgCardHover: "#1a1a2e",
  border: "#2a2a3e",

  brand: "#00e5ff",
  brandDim: "#0099aa",
  brandGlow: "rgba(0, 229, 255, 0.3)",

  accent: "#ff6ec7",
  accentDim: "#cc5aa0",

  success: "#00ff88",
  warning: "#ffaa00",
  error: "#ff4444",

  text: "#e0e0e0",
  textMuted: "#808090",
  textBright: "#ffffff",
} as const;

export const fonts = {
  mono: "JetBrains Mono, SF Mono, Menlo, monospace",
  sans: "Inter, SF Pro, system-ui, sans-serif",
} as const;

export const sizes = {
  /** Standard reel: 1080x1920 (9:16) */
  reelWidth: 1080,
  reelHeight: 1920,
  /** Landscape demo: 1920x1080 (16:9) */
  landscapeWidth: 1920,
  landscapeHeight: 1080,
} as const;
