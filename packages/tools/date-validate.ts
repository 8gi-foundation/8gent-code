/**
 * Check if a date string is valid in any supported format.
 * @param str - Date string to validate
 * @returns True if valid, false otherwise
 */
export function isValid(str: string): boolean {
  return parse(str) !== null;
}

/**
 * Parse a date string into a Date object.
 * @param str - Date string to parse
 * @returns Date object or null if invalid
 */
export function parse(str: string): Date | null {
  const formats = [
    { regex: /\d{4}-\d{2}-\d{2}/, parse: (parts: string[]) => new Date(parts[0], parseInt(parts[1]) - 1, parseInt(parts[2])) },
    { regex: /\d{2}\/\d{2}\/\d{4}/, parse: (parts: string[]) => new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0])) },
    { regex: /\d{2}\/\d{2}\/\d{4}/, parse: (parts: string[]) => new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1])) },
    { regex: /\d{4}\.\d{2}\.\d{2}/, parse: (parts: string[]) => new Date(parts[0], parseInt(parts[1]) - 1, parseInt(parts[2])) },
  ];

  for (const { regex, parse } of formats) {
    const match = str.match(regex);
    if (match) {
      const parts = str.split(/[\/\-\.]/);
      const date = parse(parts);
      if (!isNaN(date.getTime())) {
        return date;
      }
    }
  }
  return null;
}

/**
 * Check if a date is within a range [from, to].
 * @param date - Date to check
 * @param from - Start of range
 * @param to - End of range
 * @returns True if date is within range
 */
export function isInRange(date: Date, from: Date, to: Date): boolean {
  return date >= from && date <= to;
}

/**
 * Check if a date is in the future.
 * @param date - Date to check
 * @returns True if date is after now
 */
export function isFuture(date: Date): boolean {
  return date > new Date();
}

/**
 * Check if a date is in the past.
 * @param date - Date to check
 * @returns True if date is before now
 */
export function isPast(date: Date): boolean {
  return date < new Date();
}