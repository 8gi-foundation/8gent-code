import * as crypto from 'crypto';

/**
 * Encodes username and password into a Basic Auth header.
 * @param username - The username.
 * @param password - The password.
 * @returns The encoded Basic Auth header.
 */
export function encode(username: string, password: string): string {
  const auth = `${username}:${password}`;
  return `Basic ${Buffer.from(auth).toString('base64')}`;
}

/**
 * Decodes a Basic Auth header into username and password.
 * @param header - The Basic Auth header.
 * @returns An object with username and password, or null if invalid.
 */
export function decode(header: string): { username: string; password: string } | null {
  if (!header.startsWith('Basic ')) return null;
  const encoded = header.slice(6);
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    const [username, password] = decoded.split(':');
    if (!username || !password) return null;
    return { username, password };
  } catch {
    return null;
  }
}

/**
 * Validates a Basic Auth header against given credentials.
 * @param header - The Basic Auth header.
 * @param credentials - The credentials to validate against.
 * @returns True if valid, false otherwise.
 */
export function validate(header: string, credentials: { username: string; password: string }): boolean {
  const { username: decodedUser, password: decodedPass } = decode(header) || {};
  if (!decodedUser || !decodedPass) return false;
  if (credentials.username.length !== decodedUser.length || credentials.password.length !== decodedPass.length) {
    return false;
  }
  const userMatch = crypto.timingSafeEqual(Buffer.from(credentials.username), Buffer.from(decodedUser), credentials.username.length);
  const passMatch = crypto.timingSafeEqual(Buffer.from(credentials.password), Buffer.from(decodedPass), credentials.password.length);
  return userMatch && passMatch;
}

/**
 * Checks if a header is a Basic Auth header.
 * @param header - The header to check.
 * @returns True if it's a Basic Auth header.
 */
export function isBasicAuth(header: string): boolean {
  return header.startsWith('Basic ');
}