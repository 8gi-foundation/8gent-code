/**
 * Represents a rational number as a fraction.
 */
export class Fraction {
  /**
   * Creates a new Fraction instance.
   * @param numerator - The numerator of the fraction.
   * @param denominator - The denominator of the fraction.
   */
  constructor(
    public readonly numerator: number,
    public readonly denominator: number
  ) {
    if (denominator === 0) throw new Error('Denominator cannot be zero');
    if (denominator < 0) {
      this.numerator = -numerator;
      this.denominator = -denominator;
    }
  }

  /**
   * Adds another fraction to this fraction.
   * @param other - The other fraction to add.
   * @returns A new Fraction instance representing the sum.
   */
  add(other: Fraction): Fraction {
    return new Fraction(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator
    ).reduce();
  }

  /**
   * Subtracts another fraction from this fraction.
   * @param other - The other fraction to subtract.
   * @returns A new Fraction instance representing the difference.
   */
  subtract(other: Fraction): Fraction {
    return new Fraction(
      this.numerator * other.denominator - other.numerator * this.denominator,
      this.denominator * other.denominator
    ).reduce();
  }

  /**
   * Multiplies this fraction by another.
   * @param other - The other fraction to multiply.
   * @returns A new Fraction instance representing the product.
   */
  multiply(other: Fraction): Fraction {
    return new Fraction(
      this.numerator * other.numerator,
      this.denominator * other.denominator
    ).reduce();
  }

  /**
   * Divides this fraction by another.
   * @param other - The other fraction to divide by.
   * @returns A new Fraction instance representing the quotient.
   */
  divide(other: Fraction): Fraction {
    return new Fraction(
      this.numerator * other.denominator,
      this.denominator * other.numerator
    ).reduce();
  }

  /**
   * Reduces the fraction to its simplest form.
   * @returns A new Fraction instance in reduced form.
   */
  reduce(): Fraction {
    const gcd = Fraction.gcd(this.numerator, this.denominator);
    return new Fraction(this.numerator / gcd, this.denominator / gcd);
  }

  /**
   * Converts the fraction to a decimal string.
   * @param precision - The number of decimal places (default: 10).
   * @returns The decimal string representation.
   */
  toDecimal(precision: number = 10): string {
    return (this.numerator / this.denominator).toFixed(precision);
  }

  /**
   * Checks if this fraction is equal to another.
   * @param other - The other fraction to compare.
   * @returns True if equal, false otherwise.
   */
  equals(other: Fraction): boolean {
    return this.numerator * other.denominator === other.numerator * this.denominator;
  }

  /**
   * Compares this fraction to another.
   * @param other - The other fraction to compare.
   * @returns -1 if less, 0 if equal, 1 if greater.
   */
  compare(other: Fraction): number {
    const left = this.numerator * other.denominator;
    const right = other.numerator * this.denominator;
    return left === right ? 0 : left > right ? 1 : -1;
  }

  /**
   * Computes the greatest common divisor of two numbers.
   * @param a - First number.
   * @param b - Second number.
   * @returns The GCD of a and b.
   */
  static gcd(a: number, b: number): number {
    while (b !== 0) {
      const temp = b;
      b = a % b;
      a = temp;
    }
    return Math.abs(a);
  }
}