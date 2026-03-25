/**
 * ASCII Art Text Banner Generator
 * Renders text strings as 5-line tall ASCII art banners with optional box drawing.
 */

// 5-line font: each character is an array of 5 strings (rows), each row is a fixed-width segment.
const FONT: Record<string, string[]> = {
  A: [" __ ", "/  \\", "/ _ \\", "| (_) |", "|_/ \\_|"],  // replaced below with full map
};

// Full 5-row font for A-Z, 0-9, space, and basic punctuation.
// Width per glyph: 6 chars (padded). Rows indexed 0-4.
const GLYPHS: Record<string, string[]> = {
  " ": ["      ", "      ", "      ", "      ", "      "],
  "!": ["  ##  ", "  ##  ", "  ##  ", "      ", "  ##  "],
  ".": ["      ", "      ", "      ", "      ", "  ##  "],
  ",": ["      ", "      ", "      ", "  ##  ", " ##   "],
  "?": [" #### ", "##  ##", "   ###", "      ", "   ## "],
  "-": ["      ", "      ", "######", "      ", "      "],
  "_": ["      ", "      ", "      ", "      ", "######"],
  ":": ["  ##  ", "  ##  ", "      ", "  ##  ", "  ##  "],
  "0": [" #### ", "##  ##", "## ###", "###  #", " #### "],
  "1": ["  ##  ", " ###  ", "  ##  ", "  ##  ", "######"],
  "2": [" #### ", "##  ##", "   ## ", "  ##  ", "######"],
  "3": ["##### ", "    ##", " #### ", "    ##", "##### "],
  "4": ["##  ##", "##  ##", "######", "    ##", "    ##"],
  "5": ["######", "##    ", "##### ", "    ##", "##### "],
  "6": [" #### ", "##    ", "##### ", "##  ##", " #### "],
  "7": ["######", "    ##", "   ## ", "  ##  ", "  ##  "],
  "8": [" #### ", "##  ##", " #### ", "##  ##", " #### "],
  "9": [" #### ", "##  ##", " #####", "    ##", " #### "],
  A: [" #### ", "##  ##", "######", "##  ##", "##  ##"],
  B: ["##### ", "##  ##", "##### ", "##  ##", "##### "],
  C: [" #### ", "##  ##", "##    ", "##  ##", " #### "],
  D: ["##### ", "##  ##", "##  ##", "##  ##", "##### "],
  E: ["######", "##    ", "####  ", "##    ", "######"],
  F: ["######", "##    ", "####  ", "##    ", "##    "],
  G: [" #### ", "##    ", "## ###", "##  ##", " #####"],
  H: ["##  ##", "##  ##", "######", "##  ##", "##  ##"],
  I: ["######", "  ##  ", "  ##  ", "  ##  ", "######"],
  J: ["######", "    ##", "    ##", "##  ##", " #### "],
  K: ["##  ##", "##  # ", "####  ", "##  # ", "##  ##"],
  L: ["##    ", "##    ", "##    ", "##    ", "######"],
  M: ["##  ##", "######", "## ## ", "##  ##", "##  ##"],
  N: ["##  ##", "###  #", "## ## ", "##  ##", "##  ##"],
  O: [" #### ", "##  ##", "##  ##", "##  ##", " #### "],
  P: ["##### ", "##  ##", "##### ", "##    ", "##    "],
  Q: [" #### ", "##  ##", "##  ##", "## ###", " #####"],
  R: ["##### ", "##  ##", "##### ", "## ## ", "##  ##"],
  S: [" #### ", "##    ", " #### ", "    ##", " #### "],
  T: ["######", "  ##  ", "  ##  ", "  ##  ", "  ##  "],
  U: ["##  ##", "##  ##", "##  ##", "##  ##", " #### "],
  V: ["##  ##", "##  ##", "##  ##", " ####  ", "  ##  "],
  W: ["##  ##", "##  ##", "## ## ", "######", "##  ##"],
  X: ["##  ##", " #### ", "  ##  ", " #### ", "##  ##"],
  Y: ["##  ##", "##  ##", " #### ", "  ##  ", "  ##  "],
  Z: ["######", "   ## ", "  ##  ", " ##   ", "######"],
};

export interface RenderOptions {
  /** Character used for filled pixels. Default: '#' */
  fillChar?: string;
  /** Padding between glyphs in columns. Default: 1 */
  glyphGap?: number;
}

/**
 * Render text as a 5-line ASCII art banner.
 * Returns an array of 5 strings (one per row).
 */
export function render(text: string, options: RenderOptions = {}): string[] {
  const { fillChar = "#", glyphGap = 1 } = options;
  const upper = text.toUpperCase();
  const rows: string[][] = [[], [], [], [], []];
  const gap = " ".repeat(glyphGap);

  for (let i = 0; i < upper.length; i++) {
    const ch = upper[i];
    const glyph = GLYPHS[ch] ?? GLYPHS[" "];
    for (let row = 0; row < 5; row++) {
      const seg = fillChar !== "#" ? glyph[row].replace(/#/g, fillChar) : glyph[row];
      rows[row].push(seg);
    }
  }

  return rows.map((r) => r.join(gap));
}

/**
 * Wrap rendered banner lines in a Unicode box-drawing border.
 * Returns the full block as a single string ready to print.
 */
export function box(lines: string[], padding = 1): string {
  const pad = " ".repeat(padding);
  const width = Math.max(...lines.map((l) => l.length)) + padding * 2;
  const top = "\u250c" + "\u2500".repeat(width) + "\u2510";
  const bottom = "\u2514" + "\u2500".repeat(width) + "\u2518";
  const empty = "\u2502" + " ".repeat(width) + "\u2502";
  const inner = lines.map((l) => {
    const right = " ".repeat(width - pad.length - l.length);
    return "\u2502" + pad + l + right + "\u2502";
  });
  const result = [top];
  for (let i = 0; i < padding; i++) result.push(empty);
  result.push(...inner);
  for (let i = 0; i < padding; i++) result.push(empty);
  result.push(bottom);
  return result.join("\n");
}

/**
 * Convenience: render text and wrap in a box. Returns ready-to-print string.
 */
export function banner(text: string, options: RenderOptions & { padding?: number } = {}): string {
  const { padding = 1, ...renderOpts } = options;
  return box(render(text, renderOpts), padding);
}

// CLI entrypoint
if (import.meta.main) {
  const text = process.argv[2] ?? "8GENT";
  console.log(banner(text));
}
