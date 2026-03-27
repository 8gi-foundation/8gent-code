/**
 * Models exponential population growth.
 * @param N0 Initial population
 * @param r Growth rate
 * @param t Time
 * @returns Population at time t
 */
export function exponentialGrowth(N0: number, r: number, t: number): number {
  return N0 * Math.exp(r * t);
}

/**
 * Calculates doubling time for exponential growth.
 * @param N0 Initial population
 * @param r Growth rate
 * @returns Doubling time
 */
export function getDoublingTime(N0: number, r: number): number {
  return Math.log(2) / r;
}

/**
 * Models logistic population growth using Runge-Kutta 4 integration.
 */
export class LogisticModel {
  private N0: number;
  private r: number;
  private K: number;

  /**
   * @param N0 Initial population
   * @param r Growth rate
   * @param K Carrying capacity
   */
  constructor(N0: number, r: number, K: number) {
    this.N0 = N0;
    this.r = r;
    this.K = K;
  }

  /**
   * Simulates logistic growth over time.
   * @param tMax Maximum time
   * @param steps Number of time steps
   * @returns Time series of population values
   */
  simulate(tMax: number, steps: number): number[] {
    const dt = tMax / steps;
    let t = 0;
    let N = this.N0;
    const result = [N];
    for (let i = 0; i < steps; i++) {
      const k1 = this.r * N * (1 - N / this.K);
      const k2 = this.r * (N + k1 * dt / 2) * (1 - (N + k1 * dt / 2) / this.K);
      const k3 = this.r * (N + k2 * dt / 2) * (1 - (N + k2 * dt / 2) / this.K);
      const k4 = this.r * (N + k3 * dt) * (1 - (N + k3 * dt) / this.K);
      N += (k1 + 2 * k2 + 2 * k3 + k4) * dt / 6;
      result.push(N);
    }
    return result;
  }
}