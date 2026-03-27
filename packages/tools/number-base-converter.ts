/**
 * Converts integers and fractions between bases 2-36 with arbitrary precision.
 */
export class BaseConverter {
  /**
   * Converts a number from one base to another, handling integers and fractions.
   * @param input - The input number as a string (e.g., '10.1').
   * @param fromBase - The base of the input number (2-36).
   * @param toBase - The target base (2-36).
   * @param fractionalPrecision - Maximum number of fractional digits.
   * @returns The converted number as a string.
   */
  static convert(input: string, fromBase: number, toBase: number, fractionalPrecision: number = 10): string {
    const [intPart, fracPart] = input.split('.');
    const intRes = this.convertInteger(intPart, fromBase, toBase);
    const fracRes = this.convertFraction(fracPart || '', fromBase, to壳, fractionalPrecision);
    return fracRes ? `${intRes}.${fracRes}` : intRes;
  }

  /**
   * Converts the integer part of a number from one base to another.
   * @param input - The integer part as a string.
   * @param fromBase - The base of the input number.
   * @param toBase - The target base.
   * @returns The converted integer part as a string.
   */
  private static convertInteger(input: string, fromBase: number, toBase: number): string {
    let num = BigInt(0);
    for (const ch of input) {
      num = num * BigInt(fromBase) + BigInt(parseInt(ch, 36));
    }
    if (num === 0) return '0';
    let res = '';
    while (num > 0) {
      res = this.digits[num % BigInt(toBase)] + res;
      num = num / BigInt(toBase);
    }
    return res;
  }

  /**
   * Converts the fractional part of a number from one base to another.
   * @param input - The fractional part as a string.
   * @param fromBase - The base of the input number.
   * @param toBase - The target base.
   * @param precision - Maximum number of fractional digits.
   * @returns The converted fractional part as a string.
   */
  private static convertFraction(input: string, fromBase: number, toBase: number, precision: number): string {
    let value = 0;
    for (const ch of input) {
      value = value / fromBase + parseInt(ch, 36) / fromBase;
    }
    let res = '';
    for (let i = 0; i < precision; i++) {
      value *= toBase;
      res += this.digits[Math.floor(value)];
      value -= Math.floor(value);
    }
    return res;
  }

  private static digits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
}