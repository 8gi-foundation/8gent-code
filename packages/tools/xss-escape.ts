/**
 * Escape HTML special characters.
 * @param str The string to escape.
 * @returns The escaped string.
 */
export function escape(str: string): string {
  return str.replace(/[&<>"']/g, (match) => {
    switch (match) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return match;
    }
  });
}

/**
 * Escape string for HTML attribute values.
 * @param str The string to escape.
 * @returns The escaped string.
 */
export function escapeAttr(str: string): string {
  return escape(str);
}

/**
 * Escape string for CSS values.
 * @param str The string to escape.
 * @returns The escaped string.
 */
export function escapeCSS(str: string): string {
  return str.replace(/["']/g, (match) => {
    return match === '"' ? '&quot;' : '&#39;';
  });
}

/**
 * Escape string for URL parameter values.
 * @param str The string to escape.
 * @returns The escaped string.
 */
export function escapeURL(str: string): string {
  return str.replace(/&/g, '&amp;');
}