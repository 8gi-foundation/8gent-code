/**
 * format-number.ts
 * Locale-aware number formatting utilities built on Intl.NumberFormat.
 * Status: quarantine - standalone, no side effects, no external deps.
 *
 * Distinct from number-formatter.ts which uses regex/manual logic.
 * This module delegates to the platform Intl layer for correctness.
 */

export interface FormatNumberOptions {
  /** BCP 47 locale tag, e.g. "en-US", "de-DE", "ja-JP". Defaults to "en-US". */
  locale?: string;
  /** Number of decimal places. Defaults to 0 for integers, 2 for currency. */
  decimals?: number;
  /** Currency ISO 4217 code, e.g. "USD", "EUR". Enables currency mode. */
  currency?: string;
  /** Render as percentage (0.75 => "75%"). */
  percent?: boolean;
  /** Compact notation: 1200 => "1.2K", 3_400_000 => "3.4M". */
  compact?: boolean;
  /** Ordinal notation: 1 => "1st", 2 => "2nd". */
  ordinal?: boolean;
  /** File size formatting: 1536 => "1.5 KB". */
  fileSize?: boolean;
}

// ---------------------------------------------------------------------------
// Core dispatcher
// ---------------------------------------------------------------------------

/**
 * Format a number with locale-aware separators and optional transformations.
 *
 * @example
 * formatNumber(1234567)                          // "1,234,567"
 * formatNumber(1234.5, { decimals: 2 })          // "1,234.50"
 * formatNumber(0.753, { percent: true })         // "75.3%"
 * formatNumber(9.99, { currency: "USD" })        // "$9.99"
 * formatNumber(1_200_000, { compact: true })     // "1.2M"
 * formatNumber(3, { ordinal: true })             // "3rd"
 * formatNumber(1_572_864, { fileSize: true })    // "1.5 MB"
 */
export function formatNumber(
  n: number,
  options: FormatNumberOptions = {}
): string {
  if (!isFinite(n) || isNaN(n)) return "0";

  if (options.fileSize) return formatFileSize(n);
  if (options.ordinal) return formatOrdinal(n);
  if (options.compact) return formatCompact(n, options.locale, options.decimals);
  if (options.percent) return formatPercent(n, options.locale, options.decimals);
  if (options.currency) return formatCurrency(n, options.currency, options.locale, options.decimals);

  return formatDecimal(n, options.locale, options.decimals);
}

// ---------------------------------------------------------------------------
// Individual helpers - exported so callers can use them directly
// ---------------------------------------------------------------------------

/**
 * Format with locale-aware thousands separator and optional decimal places.
 * formatDecimal(1234567.89, "en-US", 2) => "1,234,567.89"
 * formatDecimal(1234567.89, "de-DE", 2) => "1.234.567,89"
 */
export function formatDecimal(
  n: number,
  locale = "en-US",
  decimals?: number
): string {
  const opts: Intl.NumberFormatOptions =
    decimals !== undefined
      ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
      : {};
  return new Intl.NumberFormat(locale, opts).format(n);
}

/**
 * Format with currency symbol, locale-aware.
 * formatCurrency(9.99, "USD")          => "$9.99"
 * formatCurrency(9.99, "EUR", "de-DE") => "9,99 €"
 */
export function formatCurrency(
  n: number,
  currency: string,
  locale = "en-US",
  decimals?: number
): string {
  const opts: Intl.NumberFormatOptions = {
    style: "currency",
    currency,
    ...(decimals !== undefined
      ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
      : {}),
  };
  return new Intl.NumberFormat(locale, opts).format(n);
}

/**
 * Format a decimal ratio as a percentage.
 * formatPercent(0.753)              => "75.3%"
 * formatPercent(1)                  => "100%"
 * formatPercent(0.1234, "en-US", 2) => "12.34%"
 */
export function formatPercent(
  n: number,
  locale = "en-US",
  decimals?: number
): string {
  const opts: Intl.NumberFormatOptions = {
    style: "percent",
    ...(decimals !== undefined
      ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
      : { maximumFractionDigits: 1 }),
  };
  return new Intl.NumberFormat(locale, opts).format(n);
}

/**
 * Compact notation - delegates to Intl for locale correctness.
 * formatCompact(1200)       => "1.2K"
 * formatCompact(3_400_000)  => "3.4M"
 * formatCompact(1.5e12)     => "1.5T"
 */
export function formatCompact(
  n: number,
  locale = "en-US",
  decimals?: number
): string {
  const opts: Intl.NumberFormatOptions = {
    notation: "compact",
    compactDisplay: "short",
    ...(decimals !== undefined
      ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
      : { maximumFractionDigits: 1 }),
  };
  return new Intl.NumberFormat(locale, opts).format(n);
}

/**
 * Ordinal suffix formatting.
 * formatOrdinal(1)  => "1st"
 * formatOrdinal(2)  => "2nd"
 * formatOrdinal(11) => "11th"
 * formatOrdinal(21) => "21st"
 */
export function formatOrdinal(n: number): string {
  const abs = Math.abs(Math.floor(n));
  const mod100 = abs % 100;
  const mod10 = abs % 10;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  if (mod10 === 1) return `${n}st`;
  if (mod10 === 2) return `${n}nd`;
  if (mod10 === 3) return `${n}rd`;
  return `${n}th`;
}

/**
 * File size using binary units (IEC 80000-13).
 * formatFileSize(0)             => "0 B"
 * formatFileSize(1024)          => "1.0 KB"
 * formatFileSize(1_572_864)     => "1.5 MB"
 * formatFileSize(1_073_741_824) => "1.0 GB"
 */
export function formatFileSize(bytes: number, decimals = 1): string {
  if (!isFinite(bytes) || isNaN(bytes) || bytes < 0) return "0 B";
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
  let index = 0;
  let value = bytes;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }

  return index === 0
    ? `${Math.round(value)} B`
    : `${value.toFixed(decimals)} ${units[index]}`;
}
