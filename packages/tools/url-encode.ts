/**
 * Encodes a string using full percent-encoding.
 * @param str - The string to encode.
 * @returns The percent-encoded string.
 */
export function encode(str: string): string {
  return encodeURIComponent(str).replace(/%20/g, '+').replace(/%5B/g, '[').replace(/%5D/g, ']');
}

/**
 * Decodes a percent-encoded string.
 * @param str - The string to decode.
 * @returns The decoded string.
 */
export function decode(str: string): string {
  return decodeURIComponent(str);
}

/**
 * Encodes a string as a URL component, stricter than encodeURIComponent.
 * @param str - The string to encode.
 * @returns The encoded string.
 */
export function encodeComponent(str: string): string {
  return encodeURIComponent(str);
}

/**
 * Encodes a record as application/x-www-form-urlencoded.
 * @param obj - The object to encode.
 * @returns The encoded string.
 */
export function encodeForm(obj: Record<string, string>): string {
  return new URLSearchParams(obj).toString();
}

/**
 * Decodes application/x-www-form-urlencoded into a record.
 * @param str - The string to decode.
 * @returns The decoded record.
 */
export function decodeForm(str: string): Record<string, string> {
  const params = new URLSearchParams(str);
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}