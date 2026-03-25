/**
 * number-formatter.ts
 * Human-readable number formatting utilities.
 * Status: quarantine - standalone, no side effects, no external deps.
 */

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
const SI_SUFFIXES = [
  { threshold: 1e15, suffix: "P" },
  { threshold: 1e12, suffix: "T" },
  { threshold: 1e9, suffix: "B" },
  { threshold: 1e6, suffix: "M" },
  { threshold: 1e3, suffix: "K" },
] as const;

/**
 * Format a byte count into a human-readable string.
 * formatBytes(1024)       => "1.0 KB"
 * formatBytes(1536)       => "1.5 KB"
 * formatBytes(1073741824) => "1.0 GB"
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (!isFinite(bytes) || isNaN(bytes)) return "0 B";
  if (bytes === 0) return "0 B";

  const abs = Math.abs(bytes);
  const sign = bytes < 0 ? "-" : "";
  let index = 0;
  let value = abs;

  while (value >= 1024 && index < BYTE_UNITS.length - 1) {
    value /= 1024;
    index++;
  }

  return `${sign}${value.toFixed(decimals)} ${BYTE_UNITS[index]}`;
}

/**
 * Format a large number with SI suffixes.
 * formatNumber(1200)    => "1.2K"
 * formatNumber(3400000) => "3.4M"
 * formatNumber(42)      => "42"
 */
export function formatNumber(n: number, decimals = 1): string {
  if (!isFinite(n) || isNaN(n)) return "0";

  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";

  for (const { threshold, suffix } of SI_SUFFIXES) {
    if (abs >= threshold) {
      const value = abs / threshold;
      return `${sign}${value.toFixed(decimals)}${suffix}`;
    }
  }

  // Below 1K - use comma separation
  return `${sign}${formatWithCommas(n)}`;
}

/**
 * Format a number with comma separators.
 * formatWithCommas(1234567) => "1,234,567"
 * formatWithCommas(42.5)    => "42.5"
 */
export function formatWithCommas(n: number): string {
  if (!isFinite(n) || isNaN(n)) return "0";
  const [integer, decimal] = n.toString().split(".");
  const withCommas = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decimal !== undefined ? `${withCommas}.${decimal}` : withCommas;
}

/**
 * Format a decimal as a percentage string.
 * formatPercent(0.753)  => "75.3%"
 * formatPercent(1)      => "100.0%"
 * formatPercent(0.1234) => "12.3%"
 */
export function formatPercent(n: number, decimals = 1): string {
  if (!isFinite(n) || isNaN(n)) return "0%";
  return `${(n * 100).toFixed(decimals)}%`;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * formatDuration(500)      => "500ms"
 * formatDuration(61000)    => "1m 1s"
 * formatDuration(3661000)  => "1h 1m 1s"
 * formatDuration(90061000) => "1d 1h 1m 1s"
 */
export function formatDuration(ms: number): string {
  if (!isFinite(ms) || isNaN(ms) || ms < 0) return "0ms";

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const millis = ms % 1000;

  if (totalSeconds === 0) return `${Math.round(millis)}ms`;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(" ");
}

/**
 * Format a number as an ordinal string.
 * formatOrdinal(1)  => "1st"
 * formatOrdinal(2)  => "2nd"
 * formatOrdinal(3)  => "3rd"
 * formatOrdinal(11) => "11th"
 * formatOrdinal(21) => "21st"
 */
export function formatOrdinal(n: number): string {
  const abs = Math.abs(Math.floor(n));
  const mod100 = abs % 100;
  const mod10 = abs % 10;

  // 11th, 12th, 13th are exceptions
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;

  if (mod10 === 1) return `${n}st`;
  if (mod10 === 2) return `${n}nd`;
  if (mod10 === 3) return `${n}rd`;
  return `${n}th`;
}

/**
 * Format a number to a fixed count of significant digits.
 * formatSignificant(0.001234, 3) => "0.00123"
 * formatSignificant(12345, 3)    => "12300"
 * formatSignificant(0.9999, 2)   => "1.0"
 */
export function formatSignificant(n: number, sigFigs = 3): string {
  if (!isFinite(n) || isNaN(n)) return "0";
  if (n === 0) return "0";
  return parseFloat(n.toPrecision(sigFigs)).toString();
}
