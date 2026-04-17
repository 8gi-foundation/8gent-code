/**
 * Fixed-point decimal arithmetic to avoid floating-point precision errors.
 * All values stored as BigInt scaled by 10^precision.
 */

const DEFAULT_PRECISION = 10;

export class Decimal {
  private readonly scaled: bigint;
  private readonly precision: number;
  private readonly factor: bigint;

  constructor(value: string | number | bigint, precision = DEFAULT_PRECISION) {
    this.precision = precision;
    this.factor = BigInt(10) ** BigInt(precision);
    if (typeof value === 'bigint') {
      this.scaled = value;
    } else {
      this.scaled = Decimal.parse(String(value), precision);
    }
  }

  private static parse(value: string, precision: number): bigint {
    const factor = BigInt(10) ** BigInt(precision);
    const negative = value.startsWith('-');
    const abs = negative ? value.slice(1) : value;
    const [intPart = '0', fracPart = ''] = abs.split('.');
    const truncated = fracPart.slice(0, precision).padEnd(precision, '0');
    const scaled = BigInt(intPart) * factor + BigInt(truncated);
    return negative ? -scaled : scaled;
  }

  private from(scaled: bigint): Decimal {
    return Object.assign(Object.create(Decimal.prototype), {
      scaled, precision: this.precision, factor: this.factor,
    }) as Decimal;
  }

  add(other: Decimal): Decimal { this.assertSamePrecision(other); return this.from(this.scaled + other.scaled); }
  sub(other: Decimal): Decimal { this.assertSamePrecision(other); return this.from(this.scaled - other.scaled); }
  mul(other: Decimal): Decimal { this.assertSamePrecision(other); return this.from((this.scaled * other.scaled) / this.factor); }
  div(other: Decimal): Decimal {
    this.assertSamePrecision(other);
    if (other.scaled === 0n) throw new Error('Division by zero');
    return this.from((this.scaled * this.factor) / other.scaled);
  }
  abs(): Decimal { return this.from(this.scaled < 0n ? -this.scaled : this.scaled); }

  round(decimalPlaces = 0): Decimal {
    const shift = BigInt(10) ** BigInt(this.precision - decimalPlaces);
    const half = shift / 2n;
    const sign = this.scaled < 0n ? -1n : 1n;
    const abs = this.scaled < 0n ? -this.scaled : this.scaled;
    return this.from(sign * (((abs + half) / shift) * shift));
  }

  floor(decimalPlaces = 0): Decimal {
    const shift = BigInt(10) ** BigInt(this.precision - decimalPlaces);
    const floored = (this.scaled / shift) * shift;
    return this.from(this.scaled % shift < 0n ? floored - shift : floored);
  }

  ceil(decimalPlaces = 0): Decimal {
    const shift = BigInt(10) ** BigInt(this.precision - decimalPlaces);
    const truncated = (this.scaled / shift) * shift;
    return this.from(this.scaled % shift > 0n ? truncated + shift : truncated);
  }

  compareTo(other: Decimal): -1 | 0 | 1 {
    this.assertSamePrecision(other);
    if (this.scaled < other.scaled) return -1;
    if (this.scaled > other.scaled) return 1;
    return 0;
  }

  equals(other: Decimal): boolean { return this.compareTo(other) === 0; }

  toString(): string {
    const negative = this.scaled < 0n;
    const abs = negative ? -this.scaled : this.scaled;
    const intPart = abs / this.factor;
    const fracPart = abs % this.factor;
    const frac = fracPart.toString().padStart(this.precision, '0').replace(/0+$/, '');
    const result = frac.length > 0 ? intPart + '.' + frac : String(intPart);
    return negative ? '-' + result : result;
  }

  toNumber(): number { return Number(this.scaled) / Number(this.factor); }

  private assertSamePrecision(other: Decimal): void {
    if (this.precision !== other.precision) {
      throw new Error('Precision mismatch: ' + this.precision + ' vs ' + other.precision);
    }
  }
}

/** Factory shorthand: decimal("1.23") or decimal(1.23) */
export function decimal(value: string | number, precision = DEFAULT_PRECISION): Decimal {
  return new Decimal(value, precision);
}
