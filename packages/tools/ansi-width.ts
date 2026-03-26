const CJK_REGEX = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

/**
 * Removes ANSI escape codes from a string.
 * @param str - The input string.
 * @returns The string with ANSI codes removed.
 */
export function stripAnsi(str: string): string {
  return str.replace(/\x1b$$[0-9;]*m/g, '');
}

/**
 * Measures the visible width of a string, accounting for ANSI codes and CJK characters.
 * @param str - The input string.
 * @returns The visible character count.
 */
export function width(str: string): number {
  const stripped = stripAnsi(str);
  let count = 0;
  for (const char of stripped) {
    if (CJK_REGEX.test(char)) {
      count += 2;
    } else {
      count += 1;
    }
  }
  return count;
}

/**
 * Pads a string to a target width.
 * @param str - The input string.
 * @param targetWidth - The desired width.
 * @param dir - Direction to pad ('left' or 'right', default 'right').
 * @returns The padded string.
 */
export function pad(str: string, targetWidth: number, dir: 'left' | 'right' = 'right'): string {
  const currentWidth = width(str);
  if (currentWidth >= targetWidth) return str;
  const padding = ' '.repeat(targetWidth - currentWidth);
  return dir === 'left' ? padding + str : str + padding;
}

/**
 * Truncates a string to a maximum display width.
 * @param str - The input string.
 * @param maxWidth - The maximum allowed width.
 * @returns The truncated string.
 */
export function truncate(str: string, maxWidth: number): string {
  let result = '';
  let currentWidth = 0;
  for (const char of str) {
    if (currentWidth >= maxWidth) break;
    const charWidth = CJK_REGEX.test(char) ? 2 : 1;
    if (currentWidth + charWidth > maxWidth) break;
    result += char;
    currentWidth += charWidth;
  }
  return result;
}