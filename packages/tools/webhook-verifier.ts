import * as crypto from 'crypto';

/**
 * Parse the signature header into algorithm and hex.
 * @param header - The header string, e.g. 'sha256=abc123'
 * @returns Object with algorithm and hex
 */
function parse(header: string): { algorithm: string; hex: string } {
  const [algo, hex] = header.split('=');
  return { algorithm: algo, hex };
}

/**
 * Verify HMAC signature.
 * @param payload - The payload string
 * @param signature - The hex signature
 * @param secret - The secret key
 * @param algorithm - Optional algorithm (default: 'sha256')
 * @returns True if signature is valid
 */
function verify(
  payload: string,
  signature: string,
  secret: string,
  algorithm: string = 'sha256'
): boolean {
  const hmac = crypto.createHmac(algorithm, secret);
  hmac.update(payload);
  const computed = hmac.digest('hex');
  return timingSafeCompare(computed, signature);
}

function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export { parse, verify };