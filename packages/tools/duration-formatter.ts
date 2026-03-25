/**
 * duration-formatter.ts
 * Human-readable duration formatting, parsing, and arithmetic.
 * Status: quarantine - standalone, no side effects, no external deps.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FormatMode = "compact" | "long" | "precise";

export interface FormatMsOptions {
  mode?: FormatMode;
  /** Maximum number of unit segments to include (default: all). */
  maxSegments?: number;
}

// Internal breakdown of a duration into unit parts.
interface Parts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  millis: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const UNIT_MS: Record<string, number> = {
  d: MS_PER_DAY,
  day: MS_PER_DAY,
  days: MS_PER_DAY,
  h: MS_PER_HOUR,
  hr: MS_PER_HOUR,
  hrs: MS_PER_HOUR,
  hour: MS_PER_HOUR,
  hours: MS_PER_HOUR,
  m: MS_PER_MINUTE,
  min: MS_PER_MINUTE,
  mins: MS_PER_MINUTE,
  minute: MS_PER_MINUTE,
  minutes: MS_PER_MINUTE,
  s: MS_PER_SECOND,
  sec: MS_PER_SECOND,
  secs: MS_PER_SECOND,
  second: MS_PER_SECOND,
  seconds: MS_PER_SECOND,
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toParts(ms: number): Parts {
  const abs = Math.abs(ms);
  const days = Math.floor(abs / MS_PER_DAY);
  const hours = Math.floor((abs % MS_PER_DAY) / MS_PER_HOUR);
  const minutes = Math.floor((abs % MS_PER_HOUR) / MS_PER_MINUTE);
  const seconds = Math.floor((abs % MS_PER_MINUTE) / MS_PER_SECOND);
  const millis = abs % MS_PER_SECOND;
  return { days, hours, minutes, seconds, millis };
}

function fromParts(p: Parts): number {
  return (
    p.days * MS_PER_DAY +
    p.hours * MS_PER_HOUR +
    p.minutes * MS_PER_MINUTE +
    p.seconds * MS_PER_SECOND +
    p.millis
  );
}

// ---------------------------------------------------------------------------
// formatMs
// ---------------------------------------------------------------------------

/**
 * Format a millisecond value into a human-readable duration string.
 *
 * Modes:
 *   compact  (default) - "2h 30m 5s"
 *   long               - "2 hours 30 minutes 5 seconds"
 *   precise            - "2h 30m 5s 120ms" (includes sub-second millis)
 *
 * @example
 * formatMs(9005120)              // "2h 30m 5s"
 * formatMs(9005120, { mode: "long" })    // "2 hours 30 minutes 5 seconds"
 * formatMs(9005120, { mode: "precise" }) // "2h 30m 5s 120ms"
 * formatMs(500)                  // "500ms"
 */
export function formatMs(ms: number, options: FormatMsOptions = {}): string {
  if (!isFinite(ms) || isNaN(ms)) return "0ms";

  const { mode = "compact", maxSegments } = options;
  const sign = ms < 0 ? "-" : "";
  const p = toParts(ms);

  type Segment = { value: number; compact: string; long: string };
  const segments: Segment[] = [
    { value: p.days, compact: `${p.days}d`, long: `${p.days} day${p.days !== 1 ? "s" : ""}` },
    { value: p.hours, compact: `${p.hours}h`, long: `${p.hours} hour${p.hours !== 1 ? "s" : ""}` },
    { value: p.minutes, compact: `${p.minutes}m`, long: `${p.minutes} minute${p.minutes !== 1 ? "s" : ""}` },
    { value: p.seconds, compact: `${p.seconds}s`, long: `${p.seconds} second${p.seconds !== 1 ? "s" : ""}` },
  ];

  if (mode === "precise") {
    segments.push({ value: p.millis, compact: `${p.millis}ms`, long: `${p.millis} millisecond${p.millis !== 1 ? "s" : ""}` });
  }

  const active = segments.filter((s) => s.value > 0);

  // Edge case: sub-second value in non-precise mode
  if (active.length === 0) {
    if (mode === "long") return `${sign}${p.millis} millisecond${p.millis !== 1 ? "s" : ""}`;
    return `${sign}${p.millis}ms`;
  }

  const capped = maxSegments != null ? active.slice(0, maxSegments) : active;
  const parts = capped.map((s) => (mode === "long" ? s.long : s.compact));
  return `${sign}${parts.join(" ")}`;
}

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

/**
 * Parse a human-readable duration string into milliseconds.
 * Returns NaN if the string cannot be parsed.
 *
 * @example
 * parseDuration("2h 30m")        // 9000000
 * parseDuration("1d 6h 15m 30s") // 108930000
 * parseDuration("500ms")         // 500
 * parseDuration("1 hour 30 minutes") // 5400000
 */
export function parseDuration(str: string): number {
  if (typeof str !== "string" || str.trim() === "") return NaN;

  // Match sequences of <number><unit> with optional whitespace
  const TOKEN = /(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/g;
  let total = 0;
  let matched = 0;

  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(str)) !== null) {
    const value = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    const multiplier = UNIT_MS[unit];
    if (multiplier === undefined) return NaN;
    total += value * multiplier;
    matched++;
  }

  if (matched === 0) return NaN;
  return Math.round(total);
}

// ---------------------------------------------------------------------------
// Arithmetic helpers
// ---------------------------------------------------------------------------

/**
 * Add two duration strings or millisecond values together.
 * Returns a millisecond number.
 *
 * @example
 * addDurations("1h", "30m")  // 5400000
 * addDurations(3600000, "15m") // 4500000
 */
export function addDurations(a: string | number, b: string | number): number {
  const msA = typeof a === "number" ? a : parseDuration(a);
  const msB = typeof b === "number" ? b : parseDuration(b);
  return msA + msB;
}

/**
 * Subtract duration b from duration a.
 * Returns a millisecond number (may be negative).
 *
 * @example
 * subtractDurations("2h", "30m")  // 5400000
 * subtractDurations("30m", "1h")  // -1800000
 */
export function subtractDurations(a: string | number, b: string | number): number {
  const msA = typeof a === "number" ? a : parseDuration(a);
  const msB = typeof b === "number" ? b : parseDuration(b);
  return msA - msB;
}

/**
 * Compare two durations.
 * Returns -1, 0, or 1 (same contract as Array.sort compareFn).
 *
 * @example
 * compareDurations("1h", "30m")  // 1
 * compareDurations("30m", "1h") // -1
 * compareDurations("60m", "1h") // 0
 */
export function compareDurations(a: string | number, b: string | number): -1 | 0 | 1 {
  const msA = typeof a === "number" ? a : parseDuration(a);
  const msB = typeof b === "number" ? b : parseDuration(b);
  if (msA < msB) return -1;
  if (msA > msB) return 1;
  return 0;
}
