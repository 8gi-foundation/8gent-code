/**
 * Rolling average calculators for metrics tracking.
 * SMA: Simple Moving Average over a fixed window.
 * EMA: Exponential Moving Average with configurable alpha.
 */

export class SimpleMovingAverage {
  private window: number[];
  private readonly windowSize: number;
  private _min: number = Infinity;
  private _max: number = -Infinity;

  constructor(windowSize: number) {
    if (windowSize < 1) throw new Error("windowSize must be >= 1");
    this.windowSize = windowSize;
    this.window = [];
  }

  add(value: number): void {
    this.window.push(value);
    if (this.window.length > this.windowSize) {
      this.window.shift();
    }
    if (value < this._min) this._min = value;
    if (value > this._max) this._max = value;
  }

  current(): number {
    if (this.window.length === 0) return NaN;
    const sum = this.window.reduce((a, b) => a + b, 0);
    return sum / this.window.length;
  }

  min(): number {
    return this._min === Infinity ? NaN : this._min;
  }

  max(): number {
    return this._max === -Infinity ? NaN : this._max;
  }

  variance(): number {
    if (this.window.length < 2) return NaN;
    const mean = this.current();
    const squaredDiffs = this.window.map((v) => (v - mean) ** 2);
    return squaredDiffs.reduce((a, b) => a + b, 0) / this.window.length;
  }

  stddev(): number {
    const v = this.variance();
    return isNaN(v) ? NaN : Math.sqrt(v);
  }

  reset(): void {
    this.window = [];
    this._min = Infinity;
    this._max = -Infinity;
  }

  get count(): number {
    return this.window.length;
  }
}

export class ExponentialMovingAverage {
  private readonly alpha: number;
  private _current: number | null = null;
  private _min: number = Infinity;
  private _max: number = -Infinity;
  private _count: number = 0;
  // For online variance via Welford's algorithm
  private _mean: number = 0;
  private _m2: number = 0;

  constructor(alpha: number) {
    if (alpha <= 0 || alpha > 1) throw new Error("alpha must be in (0, 1]");
    this.alpha = alpha;
  }

  add(value: number): void {
    if (this._current === null) {
      this._current = value;
    } else {
      this._current = this.alpha * value + (1 - this.alpha) * this._current;
    }
    if (value < this._min) this._min = value;
    if (value > this._max) this._max = value;

    // Welford's online variance over all inputs
    this._count++;
    const delta = value - this._mean;
    this._mean += delta / this._count;
    const delta2 = value - this._mean;
    this._m2 += delta * delta2;
  }

  current(): number {
    return this._current === null ? NaN : this._current;
  }

  min(): number {
    return this._min === Infinity ? NaN : this._min;
  }

  max(): number {
    return this._max === -Infinity ? NaN : this._max;
  }

  variance(): number {
    if (this._count < 2) return NaN;
    return this._m2 / this._count;
  }

  stddev(): number {
    const v = this.variance();
    return isNaN(v) ? NaN : Math.sqrt(v);
  }

  reset(): void {
    this._current = null;
    this._min = Infinity;
    this._max = -Infinity;
    this._count = 0;
    this._mean = 0;
    this._m2 = 0;
  }

  get count(): number {
    return this._count;
  }
}
