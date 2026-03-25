/**
 * text-wrap - wraps text to a specified column width respecting word boundaries.
 * Supports indent, hanging indent, newline preservation, line trimming,
 * and ANSI escape sequence awareness.
 */

export interface WrapOptions {
  /** Spaces to prepend to every line. Default: "" */
  indent?: string;
  /** Spaces to prepend to every line after the first. Overrides indent for continuation lines. */
  hangingIndent?: string;
  /** Keep existing newlines as hard breaks. Default: false */
  preserveNewlines?: boolean;
  /** Strip leading/trailing whitespace from each output line. Default: true */
  trimLines?: boolean;
}

// Matches a single ANSI CSI escape sequence.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Return the visible (display) length of a string, ignoring ANSI escapes. */
function visibleLen(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

/**
 * Split `text` into tokens: ANSI sequences are opaque zero-width tokens,
 * everything else is split on whitespace boundaries.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(ANSI_RE.source, "g");
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) tokens.push(...text.slice(last, m.index).split(/(\s+)/));
    tokens.push(m[0]);
    last = re.lastIndex;
  }
  if (last < text.length) tokens.push(...text.slice(last).split(/(\s+)/));
  return tokens.filter((t) => t.length > 0);
}

/**
 * Core line-breaking engine used by all three exports.
 * Handles indent, hangingIndent, and width constraint.
 */
function breakIntoLines(
  words: string[],
  width: number,
  indent: string,
  hangingIndent: string,
  trimLines: boolean,
): string[] {
  const lines: string[] = [];
  let current = "";
  let isFirst = true;

  const flush = () => {
    if (current !== "") {
      lines.push(trimLines ? current.trimEnd() : current);
      current = "";
    }
  };

  const prefix = () => (isFirst ? indent : hangingIndent);

  for (const word of words) {
    if (/^\s+$/.test(word)) continue; // skip whitespace tokens between words
    const p = prefix();
    const candidate = current === "" ? p + word : current + " " + word;
    if (visibleLen(candidate) <= width || current === "") {
      current = candidate;
    } else {
      flush();
      isFirst = false;
      current = prefix() + word;
    }
  }
  flush();
  return lines;
}

/**
 * Wrap `text` to `width` columns, respecting word boundaries.
 *
 * @param text   Input string (may contain newlines).
 * @param width  Maximum column width. Default: 80.
 * @param opts   Optional formatting options.
 * @returns      Wrapped string with `\n` line separators.
 */
export function wrap(text: string, width = 80, opts: WrapOptions = {}): string {
  const indent = opts.indent ?? "";
  const hangingIndent = opts.hangingIndent ?? indent;
  const preserveNewlines = opts.preserveNewlines ?? false;
  const trimLines = opts.trimLines ?? true;

  const segments = preserveNewlines ? text.split(/\r?\n/) : [text.replace(/\r?\n/g, " ")];
  const resultParts: string[] = [];

  for (const seg of segments) {
    const words = tokenize(seg).filter((t) => !/^\s+$/.test(t));
    if (words.length === 0) {
      resultParts.push("");
      continue;
    }
    const lines = breakIntoLines(words, width, indent, hangingIndent, trimLines);
    resultParts.push(lines.join("\n"));
  }

  return resultParts.join("\n");
}

/**
 * Wrap `text` to `width` columns with no extra options.
 * Convenience wrapper for simple word-wrap use cases.
 *
 * @param text   Input string.
 * @param width  Maximum column width. Default: 80.
 * @returns      Wrapped string with `\n` line separators.
 */
export function wrapWords(text: string, width = 80): string {
  return wrap(text, width);
}

/**
 * Wrap `text` to `width` columns, correctly measuring visible width while
 * preserving ANSI escape sequences (colors, bold, etc.) in the output.
 *
 * ANSI sequences are treated as zero-width when computing line length so
 * colored terminal output wraps at the correct visible column.
 *
 * @param text   Input string possibly containing ANSI escape codes.
 * @param width  Maximum visible column width. Default: 80.
 * @returns      Wrapped string with `\n` line separators.
 */
export function wrapAnsi(text: string, width = 80): string {
  // Split into logical words including embedded ANSI runs
  const parts = tokenize(text).filter((t) => !/^\s+$/.test(t));
  const lines: string[] = [];
  let current = "";

  for (const part of parts) {
    if (current === "") {
      current = part;
    } else {
      const candidate = current + " " + part;
      if (visibleLen(candidate) <= width) {
        current = candidate;
      } else {
        lines.push(current);
        current = part;
      }
    }
  }
  if (current !== "") lines.push(current);
  return lines.join("\n");
}
