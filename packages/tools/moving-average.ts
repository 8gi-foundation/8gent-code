/**
 * Calculate simple moving average for time-series data.
 * @param data Input data array
 * @param period Calculation period
 * @returns SMA values array
 */
export function sma(data: number[], period: number): number[] {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i >= period - 1) {
      const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      result.push(sum / period);
    } else {
      result.push(NaN);
    }
  }
  return result;
}

/**
 * Calculate exponential moving average for time-series data.
 * @param data Input data array
 * @param period Calculation period
 * @returns EMA values array
 */
export function ema(data: number[], period: number): number[] {
  const result = [];
  if (data.length === 0) return result;
  const alpha = 2 / (period + 1);
  result.push(data[0]);
  for (let i = 1; i < data.length; i++) {
    result.push(result[i - 1] * (1 - alpha) + data[i] * alpha);
  }
  return result;
}

/**
 * Calculate weighted moving average for time-series data.
 * @param data Input data array
 * @param period Calculation period
 * @returns WMA values array
 */
export function wma(data: number[], period: number): number[] {
  const result = [];
  const weightSum = (period * (period + 1)) / 2;
  for (let i = 0; i < data.length; i++) {
    if (i >= period - 1) {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += data[i - period + 1 + j] * (j + 1);
      }
      result.push(sum / weightSum);
    } else {
      result.push(NaN);
    }
  }
  return result;
}

/**
 * Streaming SMA calculator for incremental updates.
 */
export class StreamingSMA {
  private buffer: number[];
  private period: number;
  /**
   * @param period Calculation period
   */
  constructor(period: number) {
    this.buffer = [];
    this.period = period;
  }
  /**
   * Add a new data point
   * @param value New value
   */
  add(value: number): void {
    this.buffer.push(value);
    if (this.buffer.length > this.period) {
      this.buffer.shift();
    }
  }
  /**
   * Get current SMA value
   */
  get sma(): number {
    if (this.buffer.length < this.period) {
      return NaN;
    }
    return this.buffer.reduce((a, b) => a + b, 0) / this.period;
  }
}

/**
 * Streaming EMA calculator for incremental updates.
 */
export class StreamingEMA {
  private emaValue: number;
  private alpha: number;
  /**
   * @param period Calculation period
   */
  constructor(period: number) {
    this.emaValue = NaN;
    this.alpha = 2 / (period + 1);
  }
  /**
   * Add a new data point
   * @param value New value
   */
  add(value: number): void {
    if (isNaN(this.emaValue)) {
      this.emaValue = value;
    } else {
      this.emaValue = this.emaValue * (1 - this.alpha) + value * this.alpha;
    }
  }
  /**
   * Get current EMA value
   */
  get ema(): number {
    return this.emaValue;
  }
}