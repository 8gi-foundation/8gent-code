/**
 * Base32 encoding and decoding utility (RFC 4648).
 * Supports standard alphabet (A-Z, 2-7) and hex alphabet (0-9, A-F).
 */
export class Base32 {
  private static readonly STANDARD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  private static readonly HEX_ALPHABET = '0123456789ABCDEF';

  /**
   * Encodes input to Base32 string.
   * @param input - Input data as Uint8Array or string.
   * @param useHex - Whether to use hex alphabet (default: false).
   * @returns Base32 encoded string.
   */
  static encode(input: Uint8Array | string, useHex: boolean = false): string {
    const alphabet = useHex ? Base32.HEX_ALPHABET : Base32.STANDARD_ALPHABET;
    const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    const result: string[] = [];
    let bits = 0;
    let value = 0;

    for (let i = 0; i < data.length; i++) {
      value = (value << 8) | data[i];
      bits += 8;
      while (bits >= 5) {
        result.push(alphabet[(value >>> (bits - 5)) & 31]);
        bits -= 5;
      }
    }

    if (bits > 0) {
      result.push(alphabet[(value << (5 - bits)) & 31]);
    }

    return result.join('');
  }

  /**
   * Decodes Base32 string to Uint8Array.
   * @param input - Base32 encoded string.
   * @param useHex - Whether to use hex alphabet (default: false).
   * @returns Decoded Uint8Array.
   * @throws Error if input contains invalid characters.
   */
  static decode(input: string, useHex: boolean = false): Uint8Array {
    const alphabet = useHex ? Base32.HEX_ALPHABET : Base32.STANDARD_ALPHABET;
    const map: Record<string, number> = {};
    for (let i = 0; i < alphabet.length; i++) {
      map[alphabet[i]] = i;
    }

    const result: number[] = [];
    let bits = 0;
    let value = 0;

    for (let i = 0; i < input.length; i++) {
      const c = input[i];
      if (c === '=') continue;
      if (!(c in map)) throw new Error('Invalid character in input');
      value = (value << 5) | map[c];
      bits += 5;
      if (bits === 40) {
        result.push((value >>> 24) & 255);
        result.push((value >>> 16) & 255);
        result.push((value >>> 8) & 255);
        result.push(value & 255);
        value = 0;
        bits = 0;
      }
    }

    if (bits > 0) {
      if (bits < 8) throw new Error('Invalid padding');
      result.push((value >>> (bits - 8)) & 255);
    }

    return new Uint8Array(result);
  }
}