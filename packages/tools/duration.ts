/**
 * Parse a human-readable duration string into milliseconds.
 * @param str - The input string (e.g., '2h 30m').
 * @returns The duration in milliseconds.
 */
function parse(str: string): number {
  let total = 0;
  const tokens = str.split(/\s+/);
  for (const token of tokens) {
    const match = token.match(/^(-?\d+)([ywdhms]+)/);
    if (!match) continue;
    const [_, numStr, unit] = match;
    const num = parseFloat(numStr);
    const unitValue = units[unit] || 0;
    total += num * unitValue;
  }
  return total;
}

/**
 * Format milliseconds into a human-readable duration string.
 * @param ms - The duration in milliseconds.
 * @param precision - Number of decimal places (default: 0).
 * @returns The formatted duration string.
 */
function format(ms: number, precision: number = 0): string {
  const parts: string[] = [];
  const unitOrder = ['y', 'w', 'd', 'h', 'm', 's', 'ms'];
  for (const unit of unitOrder) {
    const unitValue = units[unit];
    if (unitValue === undefined) continue;
    const value = ms / unitValue;
    if (value === 0) continue;
    const formattedValue = value.toFixed(precision);
    parts.push(`${formattedValue}${unit}`);
    ms -= value * unitValue;
  }
  return parts.join(' ');
}

/**
 * Humanize milliseconds into a string with the largest unit.
 * @param ms - The duration in milliseconds.
 * @returns The humanized string (e.g., '2 hours').
 */
function humanize(ms: number): string {
  const unitOrder = ['y', 'w', 'd', 'h', 'm', 's', 'ms'];
  for (const unit of unitOrder) {
    const unitValue = units[unit];
    if (unitValue === undefined) continue;
    const value = Math.floor(ms / unitValue);
    if (value > 0) {
      const name = unitNames[unit];
      const plural = value !== 1 ? 's' : '';
      return `${value} ${name}${plural}`;
    }
  }
  return '0 milliseconds';
}

/**
 * Add two durations in milliseconds.
 * @param ms1 - First duration.
 * @param ms2 - Second duration.
 * @returns Sum of the durations.
 */
function add(ms1: number, ms2: number): number {
  return ms1 + ms2;
}

/**
 * Subtract two durations in milliseconds.
 * @param ms1 - First duration.
 * @param ms2 - Second duration.
 * @returns Difference of the durations.
 */
function subtract(ms1: number, ms2: number): number {
  return ms1 - ms2;
}

const units = {
  y: 31536000000,
  w: 604800000,
  d: 86400000,
  h: 3600000,
  m: 60000,
  s: 1000,
  ms: 1,
};

const unitNames = {
  y: 'year',
  w: 'week',
  d: 'day',
  h: 'hour',
  m: 'minute',
  s: 'second',
  ms: 'millisecond',
};

export { parse, format, humanize, add, subtract };