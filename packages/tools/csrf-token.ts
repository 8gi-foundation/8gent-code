import * as crypto from 'crypto';

/**
 * Generate a random CSRF token.
 * @returns {string} Random token
 */
export function generate(): string {
  return crypto.randomBytes(32).toString('base64');
}

/**
 * Validate CSRF tokens using timing-safe comparison.
 * @param cookieToken - Token from cookie
 * @param formToken - Token from form
 * @returns {boolean} True if tokens match
 */
export function validate(cookieToken: string, formToken: string): boolean {
  const buffer1 = Buffer.from(cookieToken);
  const buffer2 = Buffer.from(formToken);
  return crypto.timingSafeEqual(buffer1, buffer2) === 1;
}

/**
 * Create HTTP header with CSRF token.
 * @param token - CSRF token
 * @returns {{name: string, value: string}} Header name and value
 */
export function createHeader(token: string): { name: string; value: string } {
  return { name: 'X-CSRF-Token', value: token };
}

/**
 * Extract CSRF token from HTTP headers.
 * @param headers - HTTP headers object
 * @returns {string | undefined} Extracted token or undefined
 */
export function extractFromHeader(headers: { [key: string]: string | undefined }): string | undefined {
  return headers['X-CSRF-Token'];
}