/**
 * Generate cryptographically secure nonce in base64url format.
 * @param len Length in bytes (default 16)
 * @returns base64url encoded nonce
 */
function generate(len = 16): string {
  const bytes = new Uint8Array(len);
  window.crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

/**
 * Generate cryptographically secure nonce in hex format.
 * @param len Length in bytes (default 16)
 * @returns hex encoded nonce
 */
function generateHex(len = 16): string {
  const bytes = new Uint8Array(len);
  window.crypto.getRandomValues(bytes);
  return encodeHex(bytes);
}

/**
 * Timing-safe comparison of two nonces.
 * @param nonce Base64url encoded nonce
 * @param stored Base64url encoded stored value
 * @returns True if equal
 */
function verify(nonce: string, stored: string): boolean {
  const a = decodeBase64Url(nonce);
  const b = decodeBase64Url(stored);
  return timingSafeEqual(a, b);
}

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function encodeHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function decodeBase64Url(b64: string): Uint8Array {
  let s = b64.replace(/-/g, '+').replace(/_/g, '/');
  const mod = s.length % 4;
  if (mod) s += '='.repeat(4 - mod);
  const raw = atob(s);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = raw.charCodeAt(i);
  }
  return arr;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

export { generate, generateHex, verify };