/**
 * string-truncate.ts
 *
 * Smart string truncation with word boundaries, multiple modes,
 * custom ellipsis, and ANSI escape code awareness.
 */

// Matches ANSI escape sequences (colors, styles, cursor moves, etc.)
const ANSI_RE = /\x1b\[[0-9;]*[mGKHFABCDJsuhlp]/g;

/** Strip ANSI codes to get the visible length of a string. */
function visibleLength(str: string): number {
  return str.replace(ANSI_RE, "").length;
}

export interface TruncateOptions {
  /** String appended (or used) to signal truncation. Default: "..." */
  ellipsis?: string;
  /** If true, break only on word boundaries (spaces). Default: false */
  wordBoundary?: boolean;
  /** Minimum chars kept before ellipsis in end-truncation. Default: 1 */
  minKeep?: number;
}

/**
 * Truncate `str` to at most `maxLen` visible characters, appending ellipsis.
 * ANSI codes are counted as zero-width (invisible).
 *
 * @param str     Input string (may contain ANSI codes)
 * @param maxLen  Maximum visible length of the result
 * @param options Optional configuration
 */
export function truncate(
  str: string,
  maxLen: number,
  options: TruncateOptions = {}
): string {
  const { ellipsis = "...", wordBoundary = false, minKeep = 1 } = options;

  if (maxLen <= 0) return ellipsis.slice(0, maxLen);
  const ellipsisLen = visibleLength(ellipsis);

  // Strip ANSI for measuring; if already short enough, return as-is.
  const plain = str.replace(ANSI_RE, "");
  if (plain.length <= maxLen) return str;

  const keepLen = Math.max(minKeep, maxLen - ellipsisLen);

  if (keepLen <= 0) return ellipsis.slice(0, maxLen);

  let cut = plain.slice(0, keepLen);

  if (wordBoundary) {
    const lastSpace = cut.lastIndexOf(" ");
    if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  }

  return cut + ellipsis;
}

/**
 * Truncate by removing characters from the start, prepending ellipsis.
 *
 * @param str     Input string
 * @param maxLen  Maximum visible length of the result
 * @param options Optional configuration
 */
export function truncateStart(
  str: string,
  maxLen: number,
  options: TruncateOptions = {}
): string {
  const { ellipsis = "...", minKeep = 1 } = options;

  if (maxLen <= 0) return ellipsis.slice(0, maxLen);
  const ellipsisLen = visibleLength(ellipsis);

  const plain = str.replace(ANSI_RE, "");
  if (plain.length <= maxLen) return str;

  const keepLen = Math.max(minKeep, maxLen - ellipsisLen);

  if (keepLen <= 0) return ellipsis.slice(0, maxLen);

  const cut = plain.slice(plain.length - keepLen);
  return ellipsis + cut;
}

/**
 * Truncate from the middle, keeping both ends.
 *
 * @param str     Input string
 * @param maxLen  Maximum visible length of the result
 * @param options Optional configuration
 */
export function truncateMiddle(
  str: string,
  maxLen: number,
  options: TruncateOptions = {}
): string {
  const { ellipsis = "...", minKeep = 1 } = options;

  if (maxLen <= 0) return ellipsis.slice(0, maxLen);
  const ellipsisLen = visibleLength(ellipsis);

  const plain = str.replace(ANSI_RE, "");
  if (plain.length <= maxLen) return str;

  const available = Math.max(minKeep * 2, maxLen - ellipsisLen);
  const headLen = Math.ceil(available / 2);
  const tailLen = Math.floor(available / 2);

  const head = plain.slice(0, headLen);
  const tail = plain.slice(plain.length - tailLen);

  return head + ellipsis + tail;
}

/**
 * Word-aware end-truncation. Always breaks on a word boundary.
 * Convenience wrapper around `truncate` with `wordBoundary: true`.
 *
 * @param str     Input string
 * @param maxLen  Maximum visible length of the result
 * @param options Optional configuration (wordBoundary forced to true)
 */
export function truncateWords(
  str: string,
  maxLen: number,
  options: Omit<TruncateOptions, "wordBoundary"> = {}
): string {
  return truncate(str, maxLen, { ...options, wordBoundary: true });
}
