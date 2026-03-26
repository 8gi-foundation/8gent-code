/**
 * Class for computing running statistics using Welford's online algorithm.
 */
export class RunningStats {
  public count: number;
  public sum: number;
  public mean: number;
  public variance: number;
  public stdDev: number;
  private M2: number;

  constructor() {
    this.count = this.sum = this.mean = this.M2 = this.variance = this.stdDev = 0;
  }

  /**
   * Add a new value to the statistics.
   * @param value The value to add.
   */
  public push(value: number): void {
    const count = this.count;
    const sum = this.sum;
    const mean = this.mean;
    const M2 = this.M2;

    this.count = count + 1;
    this.sum = sum + value;

    if (count === 0) {
      this.mean = value;
      this.M2 = 0;
    } else {
      const delta = value - mean;
      this.mean = mean + delta / (count + 1);
      this.M2 = M2 + delta * (value - this.mean);
    }

    this.variance = this.count >= 2 ? this.M2 / (this.count - 1) : 0;
    this.stdDev = Math.sqrt(this.variance);
  }

  /**
   * Reset all statistics to initial state.
   */
  public reset(): void {
    this.count = this.sum = this.mean = this.M2 = this.variance = this.stdDev = 0;
  }
}