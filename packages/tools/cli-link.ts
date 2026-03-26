/**
 * Generate OSC 8 hyperlink escape sequence.
 * @param text - Link text.
 * @param url - Target URL.
 * @returns Hyperlink escape sequence.
 */
export function link(text: string, url: string): string {
  return `\x1b]8;${url};${text}\x1b\\`;
}

/**
 * Check if terminal supports hyperlinks.
 * @returns True if supported.
 */
export function isSupported(): boolean {
  if (process.env.CI) return false;
  const term = process.env.TERM || '';
  return /xterm|alacritty|konsole|gnome-terminal/.test(term);
}

/**
 * Remove OSC 8 hyperlink escapes from string.
 * @param str - Input string.
 * @returns String without hyperlink escapes.
 */
export function stripLinks(str: string): string {
  return str.replace(/\x1b$$8;[^;]+;([^$$]+)$$\x1b\\/g, '$1');
}

/**
 * Fallback for unsupported terminals.
 * @param text - Link text.
 * @param url - Target URL.
 * @returns Fallback string.
 */
export function fallback(text: string, url: string): string {
  return `${text} (${url})`;
}