/**
 * Escapes all regex special characters in a string.
 * @param str - The string to escape.
 * @returns The escaped string.
 */
export function escape(str: string): string {
  return str.replace(/[$$^*+?.()|[]{}]/g, '\\$&');
}

/**
 * Escapes $ in replacement strings.
 * @param str - The string to escape.
 * @returns The escaped string.
 */
export function escapeReplacement(str: string): string {
  return str.replace(/\$/g, '$$');
}

/**
 * Builds a RegExp from a literal string.
 * @param str - The literal string.
 * @param flags - Optional regex flags.
 * @returns The RegExp instance.
 */
export function toPattern(str: string, flags?: string): RegExp {
  return new RegExp(escape(str), flags);
}

/**
 * Type guard to check if a value is a RegExp.
 * @param value - The value to check.
 * @returns True if value is a RegExp.
 */
export function isRegex(value: any): value is RegExp {
  return value instanceof RegExp;
}