/**
 * Date/time utilities - pure functions, no external deps.
 * Quarantine: packages/tools/datetime.ts
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Human-readable relative time string (e.g. "3 hours ago", "just now"). */
export function timeAgo(date: Date | number, now: Date | number = Date.now()): string {
  const ms = +now - +date;
  if (ms < 0) return "in the future";
  if (ms < 30 * SECOND) return "just now";
  if (ms < MINUTE) return `${Math.floor(ms / SECOND)}s ago`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  if (ms < WEEK) return `${Math.floor(ms / DAY)}d ago`;
  const weeks = Math.floor(ms / WEEK);
  return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
}

/** Format a duration in ms to a compact string (e.g. "2h 15m 3s"). */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < SECOND) return `${Math.round(ms)}ms`;

  const parts: string[] = [];
  const hours = Math.floor(ms / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  const seconds = Math.floor((ms % MINUTE) / SECOND);

  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

const RELATIVE_PATTERNS: Record<string, (n: number) => number> = {
  s: (n) => n * SECOND,
  sec: (n) => n * SECOND,
  second: (n) => n * SECOND,
  seconds: (n) => n * SECOND,
  m: (n) => n * MINUTE,
  min: (n) => n * MINUTE,
  minute: (n) => n * MINUTE,
  minutes: (n) => n * MINUTE,
  h: (n) => n * HOUR,
  hour: (n) => n * HOUR,
  hours: (n) => n * HOUR,
  d: (n) => n * DAY,
  day: (n) => n * DAY,
  days: (n) => n * DAY,
  w: (n) => n * WEEK,
  week: (n) => n * WEEK,
  weeks: (n) => n * WEEK,
};

/**
 * Parse a relative date string like "2h ago", "in 3 days", "30m ago".
 * Returns a Date relative to `now`, or null if unparseable.
 */
export function parseRelativeDate(input: string, now: Date | number = Date.now()): Date | null {
  const trimmed = input.trim().toLowerCase();
  const agoMatch = trimmed.match(/^(\d+)\s*([a-z]+)\s+ago$/);
  const inMatch = trimmed.match(/^in\s+(\d+)\s*([a-z]+)$/);

  const match = agoMatch || inMatch;
  if (!match) return null;

  const n = parseInt(match[1], 10);
  const unit = match[2];
  const fn = RELATIVE_PATTERNS[unit];
  if (!fn || isNaN(n)) return null;

  const offset = fn(n);
  return new Date(+now + (agoMatch ? -offset : offset));
}

/**
 * Check if a given date/time falls within business hours.
 * Default: Mon-Fri, 09:00-17:00 local time.
 */
export function isBusinessHours(
  date: Date = new Date(),
  opts: { startHour?: number; endHour?: number } = {},
): boolean {
  const { startHour = 9, endHour = 17 } = opts;
  const day = date.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const hour = date.getHours();
  return hour >= startHour && hour < endHour;
}

/**
 * Return the next workday (Mon-Fri) at the given hour (default 9).
 * If today is a workday and the hour hasn't passed, returns today.
 */
export function nextWorkday(from: Date = new Date(), atHour = 9): Date {
  const result = new Date(from);
  result.setMinutes(0, 0, 0);

  // If current day is a workday and we haven't passed the target hour, use today
  const day = result.getDay();
  if (day >= 1 && day <= 5 && from.getHours() < atHour) {
    result.setHours(atHour);
    return result;
  }

  // Advance to next day and skip weekends
  result.setDate(result.getDate() + 1);
  result.setHours(atHour);
  while (result.getDay() === 0 || result.getDay() === 6) {
    result.setDate(result.getDate() + 1);
  }
  return result;
}
