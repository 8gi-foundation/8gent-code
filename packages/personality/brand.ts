/**
 * 8gent Code - Brand Identity
 *
 * The infinite gentleman agent coder.
 * Never hit usage caps again.
 */

// ============================================
// Brand Definition
// ============================================

export const BRAND = {
  name: "8gent",
  fullName: "8gent Code",
  symbol: "\u221E", // Infinity symbol
  tagline: "The Infinite Gentleman",
  description: "Never hit usage caps again\u2122",

  // Color palette for TUI
  colors: {
    primary: "cyan" as const,
    accent: "yellow" as const,
    success: "green" as const,
    error: "red" as const,
    warning: "yellow" as const,
    info: "blue" as const,
    muted: "gray" as const,
  },

  // ASCII art logo
  ascii: `
   \u2588\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2557   \u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557
  \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D \u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2551\u255A\u2550\u2550\u2588\u2588\u2554\u2550\u2550\u255D
  \u255A\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2551  \u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2554\u2588\u2588\u2557 \u2588\u2588\u2551   \u2588\u2588\u2551
  \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u255D  \u2588\u2588\u2551\u255A\u2588\u2588\u2557\u2588\u2588\u2551   \u2588\u2588\u2551
  \u255A\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u255A\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2551 \u255A\u2588\u2588\u2588\u2588\u2551   \u2588\u2588\u2551
   \u255A\u2550\u2550\u2550\u2550\u255D  \u255A\u2550\u2550\u2550\u2550\u2550\u255D \u255A\u2550\u2550\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u255D  \u255A\u2550\u2550\u2550\u255D   \u255A\u2550\u255D
`,

  // Compact ASCII for smaller spaces
  asciiCompact: `
 \u2588\u2588\u2588\u2557  \u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2557   \u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557
\u2588\u2588\u2554\u2550\u2588\u2588\u2557\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2551\u255A\u2550\u2550\u2588\u2588\u2554\u2550\u2550\u255D
 \u2588\u2588\u2588\u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2554\u2588\u2588\u2557 \u2588\u2588\u2551   \u2588\u2588\u2551
\u2588\u2588\u2554\u2550\u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u255D \u2588\u2588\u2551\u255A\u2588\u2588\u2557\u2588\u2588\u2551   \u2588\u2588\u2551
 \u2588\u2588\u2588\u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2551 \u255A\u2588\u2588\u2588\u2588\u2551   \u2588\u2588\u2551
 \u255A\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u255D  \u255A\u2550\u2550\u2550\u255D   \u255A\u2550\u255D
`,

  // Single line logo for headers
  inlineLogo: "\u221E 8gent",

  // Spinner characters themed for 8gent
  spinnerFrames: [
    "\u221E", // Infinity
    "\u2734", // Star
    "\u2733", // Another star
    "\u2727", // Diamond star
    "\u2726", // Star variant
    "\u2605", // Filled star
    "\u2606", // Empty star
    "\u2736", // Six-pointed star
  ],

  // Border characters
  borders: {
    topLeft: "\u256D",
    topRight: "\u256E",
    bottomLeft: "\u2570",
    bottomRight: "\u256F",
    horizontal: "\u2500",
    vertical: "\u2502",
    cross: "\u253C",
    teeRight: "\u251C",
    teeLeft: "\u2524",
    teeDown: "\u252C",
    teeUp: "\u2534",
  },

  // Status icons
  icons: {
    success: "\u2713",
    error: "\u2717",
    warning: "\u26A0",
    info: "\u2139",
    thinking: "\u2022",
    executing: "\u25B6",
    planning: "\u25CF",
    complete: "\u2714",
    pending: "\u25CB",
    active: "\u25B8",
    infinity: "\u221E",
    star: "\u2726",
    diamond: "\u25C6",
    arrow: "\u27A4",
    bullet: "\u2022",
  },
} as const;

// ============================================
// Brand Utilities
// ============================================

/**
 * Get the full branded header line
 */
export function getBrandedHeader(): string {
  return `${BRAND.symbol} ${BRAND.fullName} - ${BRAND.tagline}`;
}

/**
 * Get the compact header
 */
export function getCompactHeader(): string {
  return `${BRAND.symbol} ${BRAND.name}`;
}

/**
 * Format text with brand styling markers
 */
export function brandText(text: string, style: "primary" | "accent" | "muted" = "primary"): string {
  // This returns text that can be parsed by the TUI for coloring
  return `[${style}]${text}[/${style}]`;
}

/**
 * Get a random spinner frame
 */
export function getSpinnerFrame(index: number): string {
  return BRAND.spinnerFrames[index % BRAND.spinnerFrames.length];
}

/**
 * Get status icon by type
 */
export function getStatusIcon(
  status: "success" | "error" | "warning" | "info" | "thinking" | "executing" | "planning" | "complete" | "pending" | "active"
): string {
  return BRAND.icons[status] || BRAND.icons.bullet;
}

/**
 * Create a branded box around text
 */
export function createBrandedBox(content: string, width: number = 60): string {
  const { borders } = BRAND;
  const horizontalLine = borders.horizontal.repeat(width - 2);

  const lines = content.split("\n");
  const paddedLines = lines.map((line) => {
    const padding = width - 4 - line.length;
    return `${borders.vertical} ${line}${" ".repeat(Math.max(0, padding))} ${borders.vertical}`;
  });

  return [
    `${borders.topLeft}${horizontalLine}${borders.topRight}`,
    ...paddedLines,
    `${borders.bottomLeft}${horizontalLine}${borders.bottomRight}`,
  ].join("\n");
}

/**
 * Create the welcome banner
 */
export function createWelcomeBanner(): string {
  return `${BRAND.ascii}
    ${BRAND.tagline}
    ${BRAND.description}
`;
}

/**
 * Create compact welcome message
 */
export function createCompactWelcome(): string {
  return `${BRAND.symbol} ${BRAND.fullName} - ${BRAND.tagline}
${BRAND.description}`;
}

// ============================================
// Brand Type Exports
// ============================================

export type BrandColor = keyof typeof BRAND.colors;
export type BrandIcon = keyof typeof BRAND.icons;

export default BRAND;
