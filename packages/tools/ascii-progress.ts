/**
 * ascii-progress
 *
 * ASCII-only progress indicators for non-TTY log environments.
 * No Unicode, no ANSI, no terminal dependencies.
 * Safe for CI logs, file output, and headless pipelines.
 */

const SPINNER_FRAMES = ["|", "/", "-", "\\"] as const;

/**
 * Returns a filled progress bar using ASCII characters.
 *
 * @example
 * asciiBar(5, 10)        // "[=====>    ] 50%"
 * asciiBar(3, 10, 20)    // "[======>             ] 30%"
 * asciiBar(10, 10)       // "[==========] 100%"
 * asciiBar(0, 10)        // "[>         ] 0%"
 */
export function asciiBar(
  current: number,
  total: number,
  width: number = 10
): string {
  if (total <= 0) return `[${">".padEnd(width)}] 0%`;

  const clamped = Math.max(0, Math.min(current, total));
  const ratio = clamped / total;
  const pct = Math.round(ratio * 100);
  const filled = Math.floor(ratio * width);

  let bar: string;
  if (clamped >= total) {
    // Complete - no arrow head, all filled
    bar = "=".repeat(width);
  } else if (filled === 0) {
    // Nothing filled yet - just arrow at start
    bar = ">" + " ".repeat(width - 1);
  } else {
    // Partial fill with arrow head
    const body = "=".repeat(filled - 1) + ">";
    const empty = " ".repeat(width - filled);
    bar = body + empty;
  }

  return `[${bar}] ${pct}%`;
}

/**
 * Returns a dots-style progress indicator.
 *
 * @example
 * dots(0, 10)   // ""
 * dots(3, 10)   // "..."
 * dots(10, 10)  // ".........."
 */
export function dots(current: number, total: number): string {
  if (total <= 0) return "";
  const clamped = Math.max(0, Math.min(current, total));
  const count = Math.round((clamped / total) * total);
  return ".".repeat(count);
}

/**
 * Returns a percentage string rounded to the nearest integer.
 *
 * @example
 * percentage(1, 3)   // "33%"
 * percentage(2, 3)   // "67%"
 * percentage(3, 3)   // "100%"
 * percentage(0, 0)   // "0%"
 */
export function percentage(current: number, total: number): string {
  if (total <= 0) return "0%";
  const clamped = Math.max(0, Math.min(current, total));
  return `${Math.round((clamped / total) * 100)}%`;
}

/**
 * Returns a fraction string showing current out of total.
 *
 * @example
 * fraction(5, 10)    // "5/10"
 * fraction(0, 100)   // "0/100"
 * fraction(7, 7)     // "7/7"
 */
export function fraction(current: number, total: number): string {
  const clamped = Math.max(0, Math.min(current, total));
  return `${clamped}/${total}`;
}

/**
 * Returns a single spinner character for the given frame index.
 * Cycles through: | / - \
 *
 * @example
 * spinner(0)   // "|"
 * spinner(1)   // "/"
 * spinner(2)   // "-"
 * spinner(3)   // "\\"
 * spinner(4)   // "|"  (wraps)
 */
export function spinner(frame: number): string {
  return SPINNER_FRAMES[Math.abs(frame) % SPINNER_FRAMES.length];
}

/**
 * Returns a full status line combining spinner, bar, fraction, and percentage.
 * Convenience function for structured log lines.
 *
 * @example
 * statusLine(0, 5, 3)   // "| [>  ] 0/5 0%"
 * statusLine(2, 5, 3)   // "/ [==>] 2/5 40%"
 */
export function statusLine(
  current: number,
  total: number,
  frame: number,
  width: number = 10
): string {
  return [
    spinner(frame),
    asciiBar(current, total, width),
    fraction(current, total),
    percentage(current, total),
  ].join(" ");
}
