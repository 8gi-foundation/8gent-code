/**
 * Normalize a filename by removing extensions and separators.
 * @param name - Filename to normalize
 * @returns Normalized filename
 */
export function normalizeFilename(name: string): string {
  return name.replace(/\.[^/.]+$/, '').replace(/[_\-]+/g, ' ').trim();
}

/**
 * Generate descriptive alt text from filename and optional context.
 * @param filename - Image filename
 * @param context - Optional contextual description
 * @returns Generated alt text
 */
export function altText(filename: string, context?: string): string {
  const base = normalizeFilename(filename).replace(/\b\w/g, c => c.toUpperCase());
  return context ? `${context} ${base}` : `An image of ${base}`;
}

/**
 * Check if alt text is purely decorative.
 * @param alt - Alt text to check
 * @returns True if decorative
 */
export function isDecorative(alt: string): boolean {
  return !alt.trim() || /\b(decorative|illustration|graphic|icon|symbol)\b/i.test(alt);
}

/**
 * Truncate text without cutting words.
 * @param alt - Text to truncate
 * @param maxLen - Maximum length
 * @returns Truncated text
 */
export function truncate(alt: string, maxLen: number): string {
  const words = alt.split(/\s+/);
  let result = '';
  for (const word of words) {
    if (result.length + word.length + 1 > maxLen) break;
    result += result ? ` ${word}` : word;
  }
  return result || alt.substring(0, maxLen);
}