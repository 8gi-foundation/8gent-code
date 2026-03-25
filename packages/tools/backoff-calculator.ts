/**
 * backoff-calculator.ts
 *
 * Calculates retry backoff delays with exponential/linear curves and
 * full/equal/decorrelated jitter strategies. Zero dependencies.
 */

export interface BackoffOptions {
  /** Base delay in milliseconds. Default: 100 */
  base?: number;
  /** Maximum delay in milliseconds. Default: 30_000 */
  max?: number;
  /** Multiplier applied each retry (exponential only). Default: 2 */
  multiplier?: number;
  /** Jitter strategy. Default: "full" */
  jitter?: "none" | "full" | "equal" | "decorrelated";
  /** Maximum number of retries (0 = unlimited). Default: 0 */
  maxRetries?: number;
}

export interface BackoffResult {
  /** Computed delay in milliseconds */
  delay: number;
  /** Retry attempt number (1-indexed) */
  attempt: number;
  /** Whether max retries has been reached */
  exhausted: boolean;
}

const DEFAULT: Required<BackoffOptions> = {
  base: 100,
  max: 30_000,
  multiplier: 2,
  jitter: "full",
  maxRetries: 0,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Calculate a single exponential backoff delay for a given attempt.
 * attempt is 1-indexed.
 */
export function exponentialBackoff(
  attempt: number,
  options: BackoffOptions = {}
): BackoffResult {
  const opts = { ...DEFAULT, ...options };
  const cap = opts.max;
  const base = opts.base;

  const raw = Math.min(base * Math.pow(opts.multiplier, attempt - 1), cap);

  let delay: number;
  switch (opts.jitter) {
    case "none":
      delay = raw;
      break;
    case "full":
      delay = rand(0, raw);
      break;
    case "equal":
      delay = raw / 2 + rand(0, raw / 2);
      break;
    case "decorrelated":
      delay = rand(base, raw * opts.multiplier);
      break;
    default:
      delay = raw;
  }

  delay = clamp(Math.round(delay), 0, cap);

  return {
    delay,
    attempt,
    exhausted: opts.maxRetries > 0 && attempt >= opts.maxRetries,
  };
}

/**
 * Calculate a single linear backoff delay for a given attempt.
 * attempt is 1-indexed.
 */
export function linearBackoff(
  attempt: number,
  options: BackoffOptions = {}
): BackoffResult {
  const opts = { ...DEFAULT, ...options };
  const cap = opts.max;

  const raw = Math.min(opts.base * attempt, cap);

  let delay: number;
  switch (opts.jitter) {
    case "none":
      delay = raw;
      break;
    case "full":
      delay = rand(0, raw);
      break;
    case "equal":
      delay = raw / 2 + rand(0, raw / 2);
      break;
    case "decorrelated":
      delay = rand(opts.base, raw + opts.base);
      break;
    default:
      delay = raw;
  }

  delay = clamp(Math.round(delay), 0, cap);

  return {
    delay,
    attempt,
    exhausted: opts.maxRetries > 0 && attempt >= opts.maxRetries,
  };
}

/**
 * Iterator that yields successive backoff delays on each call to next().
 */
export class BackoffIterator implements Iterator<BackoffResult>, Iterable<BackoffResult> {
  private attempt = 0;
  private lastDelay: number;
  private readonly opts: Required<BackoffOptions>;
  private readonly strategy: "exponential" | "linear";

  constructor(
    strategy: "exponential" | "linear" = "exponential",
    options: BackoffOptions = {}
  ) {
    this.opts = { ...DEFAULT, ...options };
    this.lastDelay = this.opts.base;
    this.strategy = strategy;
  }

  next(): IteratorResult<BackoffResult> {
    this.attempt += 1;

    let result =
      this.strategy === "exponential"
        ? exponentialBackoff(this.attempt, this.opts)
        : linearBackoff(this.attempt, this.opts);

    // Decorrelated jitter - stateful: each delay derived from previous
    if (this.opts.jitter === "decorrelated" && this.strategy === "exponential") {
      const cap = this.opts.max;
      const raw = clamp(
        rand(this.opts.base, this.lastDelay * this.opts.multiplier),
        0,
        cap
      );
      this.lastDelay = raw;
      result = { ...result, delay: Math.round(raw) };
    }

    if (result.exhausted) {
      return { value: result, done: true };
    }

    return { value: result, done: false };
  }

  reset(): void {
    this.attempt = 0;
    this.lastDelay = this.opts.base;
  }

  [Symbol.iterator](): Iterator<BackoffResult> {
    return this;
  }
}
