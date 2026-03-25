/**
 * human-time - formats dates and durations as human-friendly relative time strings
 *
 * Examples: "5 minutes ago", "in 2 hours", "3 days ago", "just now"
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

interface RelativeUnit {
  threshold: number;
  singular: string;
  plural: string;
  divisor: number;
}

const UNITS: RelativeUnit[] = [
  { threshold: 45 * SECOND,  singular: "second",  plural: "seconds",  divisor: SECOND  },
  { threshold: 45 * MINUTE,  singular: "minute",  plural: "minutes",  divisor: MINUTE  },
  { threshold: 22 * HOUR,    singular: "hour",    plural: "hours",    divisor: HOUR    },
  { threshold: 26 * DAY,     singular: "day",     plural: "days",     divisor: DAY     },
  { threshold: 11 * WEEK,    singular: "week",    plural: "weeks",    divisor: WEEK    },
  { threshold: 11 * MONTH,   singular: "month",   plural: "months",   divisor: MONTH   },
  { threshold: Infinity,     singular: "year",    plural: "years",    divisor: YEAR    },
];

function pluralize(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

/**
 * Returns a human-friendly string representing how long ago a date was.
 * e.g. "5 minutes ago", "2 hours ago", "just now"
 */
export function timeAgo(date: Date | number, base: Date | number = Date.now()): string {
  const target = typeof date === "number" ? date : date.getTime();
  const now = typeof base === "number" ? base : base.getTime();
  const diffMs = now - target;

  if (diffMs < 0) return timeUntil(date, base);
  if (diffMs < 10 * SECOND) return "just now";

  for (const unit of UNITS) {
    if (diffMs < unit.threshold) {
      const value = Math.round(diffMs / unit.divisor);
      return `${pluralize(value, unit.singular, unit.plural)} ago`;
    }
  }

  const value = Math.round(diffMs / YEAR);
  return `${pluralize(value, "year", "years")} ago`;
}

/**
 * Returns a human-friendly string representing how far in the future a date is.
 * e.g. "in 5 minutes", "in 2 hours", "in 3 days"
 */
export function timeUntil(date: Date | number, base: Date | number = Date.now()): string {
  const target = typeof date === "number" ? date : date.getTime();
  const now = typeof base === "number" ? base : base.getTime();
  const diffMs = target - now;

  if (diffMs < 0) return timeAgo(date, base);
  if (diffMs < 10 * SECOND) return "just now";

  for (const unit of UNITS) {
    if (diffMs < unit.threshold) {
      const value = Math.round(diffMs / unit.divisor);
      return `in ${pluralize(value, unit.singular, unit.plural)}`;
    }
  }

  const value = Math.round(diffMs / YEAR);
  return `in ${pluralize(value, "year", "years")}`;
}

/**
 * Formats a duration in milliseconds as a human-readable string.
 * e.g. humanDuration(90000) => "1 minute 30 seconds"
 * e.g. humanDuration(3661000) => "1 hour 1 minute"
 */
export function humanDuration(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < SECOND) return `${ms}ms`;

  const parts: string[] = [];

  if (ms >= YEAR)   { const v = Math.floor(ms / YEAR);   parts.push(pluralize(v, "year",   "years"));   ms %= YEAR;   }
  if (ms >= MONTH)  { const v = Math.floor(ms / MONTH);  parts.push(pluralize(v, "month",  "months"));  ms %= MONTH;  }
  if (ms >= DAY)    { const v = Math.floor(ms / DAY);    parts.push(pluralize(v, "day",    "days"));    ms %= DAY;    }
  if (ms >= HOUR)   { const v = Math.floor(ms / HOUR);   parts.push(pluralize(v, "hour",   "hours"));   ms %= HOUR;   }
  if (ms >= MINUTE) { const v = Math.floor(ms / MINUTE); parts.push(pluralize(v, "minute", "minutes")); ms %= MINUTE; }
  if (ms >= SECOND) { const v = Math.floor(ms / SECOND); parts.push(pluralize(v, "second", "seconds")); }

  return parts.slice(0, 2).join(" ");
}

/**
 * Returns a relative time string - past dates use "ago", future dates use "in".
 * Optionally provide a base date to compare against (defaults to now).
 */
export function formatRelative(date: Date | number, base: Date | number = Date.now()): string {
  const target = typeof date === "number" ? date : date.getTime();
  const now = typeof base === "number" ? base : base.getTime();
  return target <= now ? timeAgo(date, base) : timeUntil(date, base);
}

/**
 * Returns true if the date is within the given threshold from now.
 * Default threshold is 5 minutes.
 */
export function isRecent(date: Date | number, thresholdMs: number = 5 * MINUTE): boolean {
  const target = typeof date === "number" ? date : date.getTime();
  const diff = Math.abs(Date.now() - target);
  return diff <= thresholdMs;
}
