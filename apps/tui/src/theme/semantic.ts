/**
 * Semantic theme aliases mapped from raw tokens.
 *
 * These give meaning to the raw token values so components
 * can reference `theme.text.success` instead of `tokens.color.green`.
 */

import { color, space, size, border } from './tokens.js';

/**
 * Sentinel value for "muted" text. This does NOT map to a color string.
 * Components should detect this value and apply Ink's `dimColor` prop
 * instead of a `color` prop. Example:
 *
 *   const isMuted = theme.text.muted === MUTED;
 *   <Text dimColor={isMuted} color={isMuted ? undefined : someColor}>
 */
export const MUTED = '__dim__' as const;

export const text = {
  /** undefined = inherit terminal default foreground. Safe on any theme. */
  primary: undefined,
  /** Use dimColor prop, not a color value. See MUTED sentinel. */
  muted: MUTED,
  success: color.green,
  warning: color.yellow,
  danger: color.red,
  accent: color.cyan,
  info: color.blue,
  brand: color.magenta,
} as const;

export type TextRole = keyof typeof text;

export const borderSemantic = {
  default: border.round,
  subtle: border.single,
  accent: border.bold,
  danger: border.double,
  success: border.round,
} as const;

export const borderColor = {
  default: color.cyan,
  subtle: undefined,
  accent: color.magenta,
  danger: color.red,
  success: color.green,
} as const;

export type BorderRole = keyof typeof borderSemantic;

export const status = {
  idle: color.cyan,
  thinking: color.magenta,
  executing: color.yellow,
  success: color.green,
  error: color.red,
} as const;

export type StatusName = keyof typeof status;

export const spacing = {
  /** Between inline elements on the same line. */
  inline: space.xs,
  /** Between stacked elements (vertical gap). */
  stack: space.sm,
  /** Between logical sections. */
  section: space.md,
  /** Top-level page padding. */
  page: space.md,
} as const;

export type SpacingRole = keyof typeof spacing;

export const layout = {
  contentMaxWidth: size.lg,
  sidebarWidth: size.sm,
} as const;

export const semanticTheme = {
  text,
  border: borderSemantic,
  borderColor,
  status,
  spacing,
  layout,
  MUTED,
} as const;

export type SemanticTheme = typeof semanticTheme;
