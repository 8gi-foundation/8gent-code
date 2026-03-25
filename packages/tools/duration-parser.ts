/**
 * duration-parser.ts
 * Parses human-readable duration strings to milliseconds and back.
 * Supports: ms, s, m, h, d, w - composable (e.g. "2h30m", "1d12h")
 */

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const UNIT_ORDER: string[] = ["w", "d", "h", "m", "s", "ms"];

const TOKEN_RE = /(\d+(?:\.\d+)?)\s*(ms|[smhdw])/gi;

/**
 * Parse a human-readable duration string to milliseconds.
 * Examples: "5m", "2h30m", "1d12h", "500ms", "1w2d3h4m5s"
 * Throws if the string is empty or contains no valid tokens.
 */
export function parseDuration(str: string): number {
  if (!str || typeof str !== "string") {
    throw new TypeError(`parseDuration: expected a string, got ${typeof str}`);
  }

  const clean = str.trim();
  if (!clean) throw new RangeError("parseDuration: empty string");

  let total = 0;
  let matched = false;

  for (const match of clean.matchAll(TOKEN_RE)) {
    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    if (!(unit in UNITS)) continue;
    total += value * UNITS[unit];
    matched = true;
  }

  if (!matched) {
    throw new RangeError(`parseDuration: no valid duration tokens in "${str}"`);
  }

  return Math.round(total);
}

/**
 * Format milliseconds to a compact human-readable string.
 * Examples: 90000 -> "1m30s", 3661000 -> "1h1m1s", 500 -> "500ms"
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError(`formatDuration: expected non-negative finite number, got ${ms}`);
  }

  if (ms === 0) return "0ms";

  let remaining = Math.round(ms);
  const parts: string[] = [];

  for (const unit of UNIT_ORDER) {
    const factor = UNITS[unit];
    if (remaining >= factor) {
      const count = Math.floor(remaining / factor);
      parts.push(`${count}${unit}`);
      remaining -= count * factor;
    }
  }

  return parts.join("") || "0ms";
}

/**
 * Duration class - immutable value object for working with durations.
 */
export class Duration {
  readonly ms: number;

  constructor(value: number | string) {
    if (typeof value === "string") {
      this.ms = parseDuration(value);
    } else if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      this.ms = Math.round(value);
    } else {
      throw new TypeError(`Duration: expected non-negative number or duration string`);
    }
  }

  /** Add another duration. Returns a new Duration. */
  add(other: Duration | string | number): Duration {
    const otherMs = other instanceof Duration ? other.ms : new Duration(other).ms;
    return new Duration(this.ms + otherMs);
  }

  /** Subtract another duration. Returns a new Duration (floors at 0). */
  subtract(other: Duration | string | number): Duration {
    const otherMs = other instanceof Duration ? other.ms : new Duration(other).ms;
    return new Duration(Math.max(0, this.ms - otherMs));
  }

  /** Compare to another duration. Returns -1, 0, or 1. */
  compare(other: Duration | string | number): -1 | 0 | 1 {
    const otherMs = other instanceof Duration ? other.ms : new Duration(other).ms;
    if (this.ms < otherMs) return -1;
    if (this.ms > otherMs) return 1;
    return 0;
  }

  isGreaterThan(other: Duration | string | number): boolean {
    return this.compare(other) === 1;
  }

  isLessThan(other: Duration | string | number): boolean {
    return this.compare(other) === -1;
  }

  isEqualTo(other: Duration | string | number): boolean {
    return this.compare(other) === 0;
  }

  toString(): string {
    return formatDuration(this.ms);
  }

  toJSON(): number {
    return this.ms;
  }

  /** Convenience factory */
  static from(value: number | string): Duration {
    return new Duration(value);
  }
}
