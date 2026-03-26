import * as crypto from 'crypto';

/**
 * Generate a UUID-like correlation ID.
 * @returns {string} The generated ID.
 */
export function generate(): string {
  const buffer = crypto.randomBytes(16);
  const hex = buffer.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-');
}

/**
 * Extract correlation ID from headers.
 * @param {Record<string, string>} headers - HTTP headers.
 * @returns {string | undefined} Extracted ID or undefined.
 */
export function fromHeaders(headers: Record<string, string>): string | undefined {
  return headers['X-Correlation-ID'] || headers['X-Request-ID'];
}

/**
 * Create header object with correlation ID.
 * @param {string} id - Correlation ID.
 * @returns {Record<string, string>} Header object.
 */
export function toHeaders(id: string): Record<string, string> {
  return { 'X-Correlation-ID': id };
}

/**
 * Check if ID is valid UUID format.
 * @param {string} id - ID to check.
 * @returns {boolean} True if valid.
 */
export function isValid(id: string): boolean {
  const regex = /^([0-9a-fA-F]{8}-){4}[0-9a-fA-F]{12}$/;
  return regex.test(id);
}