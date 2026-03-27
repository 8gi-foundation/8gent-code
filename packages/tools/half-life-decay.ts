/**
 * Calculate remaining quantity after decay.
 * @param N0 Initial quantity
 * @param t Time elapsed
 * @param t_half Half-life
 * @returns Remaining quantity
 */
function decay(N0: number, t: number, t_half: number): number {
  return N0 * Math.pow(0.5, t / t_half);
}

/**
 * Calculate time to reach target fraction.
 * @param N0 Initial quantity
 * @param target Target quantity
 * @param t_half Half-life
 * @returns Time required
 */
function timeToTarget(N0: number, target: number, t_half: number): number {
  if (target >= N0) return 0;
  return (t_half / Math.log(2)) * Math.log(N0 / target);
}

/**
 * Multi-dose accumulation tracking.
 */
class MultiDose {
  private doses: { time: number; amount: number }[];
  private t_half: number;
  constructor(t_half: number) {
    this.t_half = t_half;
    this.doses = [];
  }
  /**
   * Add a dose at a specific time.
   * @param time Time of dose
   * @param amount Dose amount
   */
  addDose(time: number, amount: number): void {
    this.doses.push({ time, amount });
  }
  /**
   * Calculate peak concentration at time t.
   * @param t Time to evaluate
   * @returns Peak concentration
   */
  peak(t: number): number {
    return this.doses.reduce((sum, d) => {
      const dt = t - d.time;
      return sum + d.amount * Math.pow(0.5, dt / this.t_half);
    }, 0);
  }
  /**
   * Calculate trough concentration at time t.
   * @param t Time to evaluate
   * @returns Trough concentration
   */
  trough(t: number): number {
    return this.peak(t);
  }
}

/**
 * Combine multiple half-lives into effective half-life.
 * @param halfLives Array of half-lives
 * @returns Effective half-life
 */
function combineHalfLives(...halfLives: number[]): number {
  return 1 / halfLives.reduce((sum, t) => sum + 1 / t, 0);
}

export { decay, timeToTarget, MultiDose, combineHalfLives };