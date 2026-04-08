/**
 * Escapes a string for SQL interpolation by doubling single quotes.
 * @param value The string to escape.
 * @returns The escaped string.
 */
export function escapeString(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Escapes an identifier for SQL by wrapping in double-quotes and escaping internal quotes.
 * @param name The identifier to escape.
 * @returns The escaped identifier.
 */
export function escapeIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Escapes LIKE wildcards (%) and (_) in a string.
 * @param value The string to escape.
 * @returns The escaped string.
 */
export function escapeWildcard(value: string): string {
  return value.replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Logs a warning about preferring parameterized queries.
 * @param msg The warning message.
 */
export function warn(msg: string): void {
  console.warn(msg);
}