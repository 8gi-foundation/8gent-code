/**
 * Converts minutes to a timezone offset string (e.g., '+05:30').
 * @param minutes - Offset in minutes (positive or negative)
 * @returns Formatted offset string
 */
function offsetToString(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const absMinutes = Math.abs(minutes);
  const hours = Math.floor(absMinutes / 60);
  const mins = absMinutes % 60;
  return `${sign}${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

/**
 * Parses a timezone offset string to minutes.
 * @param str - Offset string (e.g., '+05:30')
 * @returns Offset in minutes
 * @throws Error if format is invalid
 */
function stringToOffset(str: string): number {
  const match = str.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) throw new Error('Invalid offset format');
  const sign = match[1] === '+' ? 1 : -1;
  const hours = parseInt(match[2], 10);
  const mins = parseInt(match[3], 10);
  return sign * (hours * 60 + mins);
}

/**
 * Converts a UTC date to local time using the given offset.
 * @param date - UTC Date object
 * @param offsetMinutes - Offset in minutes
 * @returns Local time Date object
 */
function utcToLocal(date: Date, offsetMinutes: number): Date {
  const utcTime = date.getTime();
  const offsetMs = offsetMinutes * 60 * 1000;
  return new Date(utcTime + offsetMs);
}

/**
 * Converts a local date to UTC using the given offset.
 * @param date - Local Date object
 * @param offsetMinutes - Offset in minutes
 * @returns UTC Date object
 */
function localToUTC(date: Date, offsetMinutes: number): Date {
  const localTime = date.getTime();
  const offsetMs = offsetMinutes * 60 * 1000;
  return new Date(localTime - offsetMs);
}

/**
 * Validates if a string is a valid timezone offset format.
 * @param str - Offset string to validate
 * @returns True if valid, false otherwise
 */
function isValidOffset(str: string): boolean {
  const match = str.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) return false;
  const hours = parseInt(match[2], 10);
  const mins = parseInt(match[3], 10);
  return !isNaN(hours) && !isNaN(mins) && mins >= 0 && mins <= 59;
}

export { offsetToString, stringToOffset, utcToLocal, localToUTC, isValidOffset };