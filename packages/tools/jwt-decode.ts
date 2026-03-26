/**
 * Decodes a JWT token into header, payload, and signature.
 * @param token - The JWT token string.
 * @returns Object with header, payload, and signature.
 */
function decode(token: string): { header: object; payload: object; signature: string } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');
  const [header, payload] = parts.map((p) => decodeBase64Url(p));
  return { header: JSON.parse(header), payload: JSON.parse(payload), signature: parts[2] };
}

/**
 * Checks if a payload contains an expired 'exp' claim.
 * @param payload - The payload object.
 * @returns True if expired, false otherwise.
 */
function isExpired(payload: object): boolean {
  const exp = payload['exp'];
  if (typeof exp !== 'number') return false;
  return Math.floor(Date.now() / 1000) >= exp;
}

/**
 * Returns the payload as a typed object.
 * @param token - The JWT token string.
 * @returns The payload object.
 */
function getClaims(token: string): object {
  return decode(token).payload;
}

/**
 * Validates the token has a 3-part structure.
 * @param token - The JWT token string.
 * @returns True if valid, false otherwise.
 */
function validateStructure(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

/**
 * Helper to convert base64url to standard base64 and decode.
 * @param input - Base64url encoded string.
 * @returns Decoded string.
 */
function decodeBase64Url(input: string): string {
  return atob(input.replace(/-/g, '+').replace(/_/g, '/').padEnd(input.length + (input.length % 4), '='));
}

export { decode, isExpired, getClaims, validateStructure };