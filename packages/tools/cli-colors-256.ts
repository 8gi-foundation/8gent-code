/**
 * Generate 256-color foreground ANSI escape code
 * @param code - 0-255 color code
 * @returns ANSI escape string
 */
export function fg256(code: number): string {
  return `\x1b[38;5;${code}m`;
}

/**
 * Generate 256-color background ANSI escape code
 * @param code - 0-255 color code
 * @returns ANSI escape string
 */
export function bg256(code: number): string {
  return `\x1b[48;5;${code}m`;
}

/**
 * Generate truecolor foreground ANSI escape code
 * @param r - 0-255 red component
 * @param g - 0-255 green component
 * @param b - 0-255 blue component
 * @returns ANSI escape string
 */
export function fgRGB(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Generate truecolor background ANSI escape code
 * @param r - 0-255 red component
 * @param g - 0-255 green component
 * @param b - 0-255 blue component
 * @returns ANSI escape string
 */
export function bgRGB(r: number, g: number, b: number): string {
  return `\x1b[48;2;${r};${g};${b}m`;
}

/**
 * Remove all ANSI escape codes from a string
 * @param str - input string
 * @returns string without ANSI codes
 */
export function strip(str: string): string {
  return str.replace(/\x1b$$[0-9;]*m/g, '');
}