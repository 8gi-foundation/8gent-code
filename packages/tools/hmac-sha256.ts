/**
 * Signs a message using HMAC-SHA256 with the given key.
 * @param key - The secret key as a string.
 * @param message - The message to sign.
 * @returns A Promise that resolves to the hexadecimal signature.
 */
async function sign(key: string, message: string): Promise<string> {
  const keyBuffer = new TextEncoder().encode(key);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const messageBuffer = new TextEncoder().encode(message);
  const signatureBuffer = await crypto.subtle.sign(
    { name: 'HMAC', hash: 'SHA-256' },
    keyMaterial,
    messageBuffer
  );
  return arrayBufferToHex(signatureBuffer);
}

/**
 * Verifies a message signature using HMAC-SHA256 with the given key.
 * @param key - The secret key as a string.
 * @param message - The message that was signed.
 * @param signature - The hexadecimal signature to verify.
 * @returns A Promise that resolves to true if the signature is valid, false otherwise.
 */
async function verify(
  key: string,
  message: string,
  signature: string
): Promise<boolean> {
  const expected = await sign(key, message);
  const expectedBuffer = hexToBuffer(expected);
  const providedBuffer = hexToBuffer(signature);
  return constantTimeCompare(expectedBuffer, providedBuffer);
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBuffer(hex: string): ArrayBuffer {
  const length = hex.length / 2;
  const buffer = new ArrayBuffer(length);
  const dataView = new DataView(buffer);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.substring(i, i + 2), 16);
    dataView.setUint8(i / 2, byte);
  }
  return buffer;
}

function constantTimeCompare(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const viewA = new Uint8Array(a);
  const viewB = new Uint8Array(b);
  let result = 0;
  for (let i = 0; i < viewA.length; i++) {
    result |= viewA[i] ^ viewB[i];
  }
  return result === 0;
}

export { sign, verify };