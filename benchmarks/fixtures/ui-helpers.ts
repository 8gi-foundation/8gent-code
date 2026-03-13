/**
 * Lightweight HTML/CSS parsing utilities for UI benchmark test assertions.
 * Zero external dependencies — regex-based parsing only.
 */

/** Extract all CSS from <style> tags and inline style="" attributes, concatenated. */
export function extractStyleBlocks(html: string): string {
  const parts: string[] = [];

  // Extract <style>...</style> contents
  const styleTagRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m: RegExpExecArray | null;
  while ((m = styleTagRe.exec(html)) !== null) {
    parts.push(m[1].trim());
  }

  // Extract inline style="..." attribute values
  const inlineRe = /style\s*=\s*"([^"]*)"/gi;
  while ((m = inlineRe.exec(html)) !== null) {
    parts.push(m[1].trim());
  }
  const inlineSingleRe = /style\s*=\s*'([^']*)'/gi;
  while ((m = inlineSingleRe.exec(html)) !== null) {
    parts.push(m[1].trim());
  }

  return parts.join("\n");
}

/** Count occurrences of a given HTML tag (opening tags). */
export function countElements(html: string, tag: string): number {
  const re = new RegExp(`<${tag}(?:\\s|>|\\/)`, "gi");
  const matches = html.match(re);
  return matches ? matches.length : 0;
}

/** Check if a CSS property exists anywhere in the CSS text. */
export function hasProperty(css: string, property: string): boolean {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[;{\\s])${escaped}\\s*:`, "im");
  return re.test(css);
}

/** Return all values for a given CSS property. */
export function getPropertyValues(css: string, property: string): string[] {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[;{\\s])${escaped}\\s*:\\s*([^;}]+)`, "gim");
  const values: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    values.push(m[1].trim());
  }
  return values;
}

/** Check if @keyframes blocks exist, optionally matching a specific name. */
export function hasKeyframes(css: string, name?: string): boolean {
  if (name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`@keyframes\\s+${escaped}\\b`, "i");
    return re.test(css);
  }
  return /@keyframes\s+/i.test(css);
}

/** Count distinct @keyframes blocks. */
export function countKeyframes(css: string): number {
  const matches = css.match(/@keyframes\s+/gi);
  return matches ? matches.length : 0;
}

/** Check for @media blocks. */
export function hasMediaQuery(css: string): boolean {
  return /@media\s/i.test(css);
}

/** Count distinct @media blocks. */
export function countMediaQueries(css: string): number {
  const matches = css.match(/@media\s/gi);
  return matches ? matches.length : 0;
}

/** Check for a pseudo-class like :hover, :active, :checked. */
export function hasPseudoClass(css: string, pseudo: string): boolean {
  const escaped = pseudo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Ensure single colon (not double) — pseudo-classes use one colon
  const re = new RegExp(`(?:[^:])${escaped}\\b`, "i");
  return re.test(css);
}

/** Check for pseudo-elements like ::before, ::after. */
export function hasPseudoElement(css: string, pseudo: string): boolean {
  const escaped = pseudo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`::${escaped}\\b`, "i");
  return re.test(css);
}

/** Check if a CSS selector pattern exists (before a { block). */
export function hasSelector(css: string, selector: string): boolean {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[},\\s])\\s*${escaped}\\s*[{,]`, "im");
  return re.test(css);
}

/** Parse a CSS numeric value like "10px", "0.5em", "50%", "300ms" into parts. */
export function parseCSSNumericValue(
  value: string
): { number: number; unit: string } | null {
  const m = value.trim().match(/^(-?\d*\.?\d+)\s*(%|[a-zA-Z]*)$/);
  if (!m) return null;
  return { number: parseFloat(m[1]), unit: m[2] || "" };
}

/** Find blur(Npx) in CSS and return N. */
export function extractBlurValue(css: string): number | null {
  const m = css.match(/blur\(\s*(\d*\.?\d+)\s*px\s*\)/i);
  if (!m) return null;
  return parseFloat(m[1]);
}

/** Parse rgba(r, g, b, a) into components. */
export function extractRGBA(
  value: string
): { r: number; g: number; b: number; a: number } | null {
  const m = value.match(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/i
  );
  if (!m) return null;
  return {
    r: parseInt(m[1], 10),
    g: parseInt(m[2], 10),
    b: parseInt(m[3], 10),
    a: m[4] !== undefined ? parseFloat(m[4]) : 1,
  };
}

/** Calculate WCAG relative luminance from sRGB values (0-255). */
export function relativeLuminance(r: number, g: number, b: number): number {
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG contrast ratio from two luminance values. */
export function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Check for box-shadow with inset keyword. */
export function hasInsetShadow(css: string): boolean {
  const shadows = getPropertyValues(css, "box-shadow");
  return shadows.some((v) => /\binset\b/i.test(v));
}

/** Count comma-separated shadow layers in a single box-shadow value string. */
export function countShadowLayers(value: string): number {
  if (!value.trim()) return 0;
  // Split on commas that are not inside parentheses
  let depth = 0;
  let count = 1;
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
}

/** Check for CSS custom properties (--variable-name). */
export function hasCustomProperties(css: string): boolean {
  return /--[\w-]+\s*:/i.test(css);
}

/** Count distinct --variable-name declarations. */
export function countCustomProperties(css: string): number {
  const matches = css.match(/--[\w-]+\s*:/g);
  if (!matches) return 0;
  const unique = new Set(matches.map((m) => m.replace(/\s*:$/, "")));
  return unique.size;
}
