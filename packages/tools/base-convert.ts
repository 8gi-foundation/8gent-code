/**
 * Converts a number from one base to another.
 * @param n - The string representation of the number in fromBase.
 * @param fromBase - The base of the input number (2-36).
 * @param toBase - The target base (2-36).
 * @returns The string representation of the number in toBase.
 */
export function convert(n: string, fromBase: number, toBase: number): string {
  if (fromBase < 2 || fromBase > 36 || toBase < 2 || toBase > 36) {
    throw new Error('Base must be between 2 and 36');
  }
  let decimal = 0;
  for (const char of n.toUpperCase()) {
    let value: number;
    if (char >= '0' && char <= '9') {
      value = parseInt(char, 10);
    } else if (char >= 'A' && char <= 'Z') {
      value = 10 + char.charCodeAt(0) - 'A'.charCodeAt(0);
    } else {
      throw new Error('Invalid character in input');
    }
    if (value >= fromBase) {
      throw new Error('Invalid digit for base');
    }
    decimal = decimal * fromBase + value;
  }
  if (decimal === 0) return '0';
  const digits: number[] = [];
  while (decimal > 0) {
    digits.push(decimal % toBase);
    decimal = Math.floor(decimal / toBase);
  }
  return digits.reverse().map(d => d < 10 ? d.toString() : String.fromCharCode('A'.charCodeAt(0) + d - 10)).join('');
}

/**
 * Converts a base 10 number to binary.
 * @param n - The string representation of the number in base 10.
 * @returns The binary string representation.
 */
export function toBinary(n: string): string {
  return convert(n, 10, 2);
}

/**
 * Converts a base 10 number to hexadecimal.
 * @param n - The string representation of the number in base 10.
 * @returns The hexadecimal string representation.
 */
export function toHexStr(n: string): string {
  return convert(n, 10, 16);
}

/**
 * Converts a base 10 number to octal.
 * @param n - The string representation of the number in base 10.
 * @returns The octal string representation.
 */
export function toOctal(n: string): string {
  return convert(n, 10, 8);
}