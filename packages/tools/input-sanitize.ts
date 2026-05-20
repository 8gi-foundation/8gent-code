/**
 * Sanitize input by removing control characters and null bytes.
 * @param input - The input string to sanitize.
 * @returns The sanitized string.
 */
export function sanitize(input: string): string {
  return input.replace(/[\x00-\x1F]/g, '');
}

/**
 * Strip HTML tags from the input string.
 * @param input - The input string containing HTML.
 * @returns The string with HTML tags removed.
 */
export function stripHTML(input: string): string {
  return input.replace(/<[^>]+>/g, '');
}

/**
 * Normalize whitespace by collapsing runs of whitespace.
 * @param input - The input string with potentially excessive whitespace.
 * @returns The string with normalized whitespace.
 */
export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/**
 * Truncate the input string to the specified maximum length.
 * @param input - The input string to truncate.
 * @param limit - The maximum allowed length.
 * @returns The truncated string if it exceeded the limit, otherwise the original.
 */
export function maxLength(input: string, limit: number): string {
  return input.length > limit ? input.slice(0, limit) : input;
}