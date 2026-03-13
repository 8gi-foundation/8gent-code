/**
 * Raw design tokens for the 8gent TUI.
 *
 * IMPORTANT: Never use "gray", "white", or "black" as color values.
 * They break on different terminal themes (light vs dark).
 * Use only the 6 safe ANSI colors below. For muted text, use
 * Ink's `dimColor` prop instead of a color value.
 */

export const color = {
  red: 'red',
  green: 'green',
  yellow: 'yellow',
  blue: 'blue',
  magenta: 'magenta',
  cyan: 'cyan',
} as const;

export type Color = (typeof color)[keyof typeof color];

export const space = {
  none: 0,
  xs: 1,
  sm: 2,
  md: 4,
} as const;

export type Space = (typeof space)[keyof typeof space];

/** Border styles available in Ink's <Box> `borderStyle` prop. */
export const border = {
  single: 'single',
  double: 'double',
  round: 'round',
  bold: 'bold',
  classic: 'classic',
} as const;

export type Border = (typeof border)[keyof typeof border];

/** Width constraints in terminal columns. */
export const size = {
  xs: 20,
  sm: 40,
  md: 60,
  lg: 80,
  xl: 120,
} as const;

export type Size = (typeof size)[keyof typeof size];

export const tokens = { color, space, border, size } as const;
