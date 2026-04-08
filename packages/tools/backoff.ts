/**
 * Exponential backoff strategy.
 * @param attempt Current attempt number (starts at 0)
 * @param base Base multiplier
 * @param max Maximum delay in ms
 * @returns Delay in ms
 */
export function exponential(attempt: number, base: number, max: number): number {
  return Math.min(Math.pow(base, attempt), max);
}

/**
 * Linear backoff strategy.
 * @param attempt Current attempt number (starts at 0)
 * @param step Increment step
 * @param max Maximum delay in ms
 * @returns Delay in ms
 */
export function linear(attempt: number, step: number, max: number): number {
  return Math.min(attempt * step, max);
}

/**
 * Constant delay strategy.
 * @param delay Fixed delay in ms
 * @returns Delay in ms
 */
export function constant(delay: number): number {
  return delay;
}

/**
 * Adds random jitter to a delay.
 * @param delay Base delay in ms
 * @param factor Jitter factor (e.g. 0.5 for ±50% variance)
 * @returns Delay with jitter
 */
export function jitter(delay: number, factor: number): number {
  return delay * (1 + (Math.random() - 0.5) * factor);
}

/**
 * Wraps a strategy with jitter.
 * @param strategy Base strategy function
 * @param factor Jitter factor
 * @returns Strategy with jitter
 */
export function withJitter(strategy: (attempt: number, ...args: any[]) => number, factor: number): (attempt: number, ...args: any[]) => number {
  return (attempt, ...args) => jitter(strategy(attempt, ...args), factor);
}