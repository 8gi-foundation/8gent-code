/**
 * Signs a payload with a secret using HMAC-SHA256 and returns a JWT string.
 * @param payload - The payload to sign.
 * @param secret - The secret key.
 * @param expiresInSec - Optional expiration time in seconds.
 * @returns JWT string.
 */
export async function sign(payload: object, secret: string, expiresInSec?: number): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payloadWithClaims = { ...payload };
  if (expiresInSec !== undefined) {
    payloadWithClaims.exp = Math.floor(Date.now() / 1000) + expiresInSec;
  }

  const encodedHeader = btoa(JSON.stringify(header)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const encodedPayload = btoa(JSON.stringify(payloadWithClaims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const data = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, data);
  const signature = arrayBufferToBase64Url(signatureBuffer);

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

/**
 * Verifies a JWT token with a secret and returns the payload.
 * @param token - The JWT token to verify.
 * @param secret - The secret key.
 * @returns The payload if valid, otherwise throws an error.
 */
export async function verify(token: string, secret: string): Promise<object> {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error('Invalid token format');
  }

  const header = JSON.parse(atob(encodedHeader.replace(/-/g, '+').replace(/_/g, '/')));
  const payload = JSON.parse(atob(encodedPayload.replace(/-/g, '+').replace(/_/g, '/')));
  const signature = encodedSignature;

  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const data = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const expectedSignature = base64UrlToBuffer(signature);
  if (!(await crypto.subtle.verify('HMAC', key, expectedSignature, data))) {
    throw new Error('Invalid signature');
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp !== undefined && now >= payload.exp) {
    throw new Error('Token expired');
  }
  if (payload.iat !== undefined && now < payload.iat) {
    throw new Error('Token not yet valid');
  }
  if (payload.nbf !== undefined && now < payload.nbf) {
    throw new Error('Token not yet valid');
  }

  return payload;
}

function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBuffer(base64Url: string): ArrayBuffer {
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64WithPadding = base64 + padding;
  const binary = atob(base64WithPadding);
  const buffer = new ArrayBuffer(binary.length);
  const dataView = new DataView(buffer);
  for (let i = 0; i < binary.length; i++) {
    dataView.setUint8(i, binary.charCodeAt(i));
  }
  return buffer;
}