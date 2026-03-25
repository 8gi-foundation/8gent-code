/**
 * Creates a typed flag object from an array of names.
 * @param names - Array of flag names.
 * @returns An object with each name mapped to a unique bit flag.
 */
export function createFlags(names: string[]): Record<string, number> {
  const flags: Record<string, number> = {};
  for (let i = 0; i < names.length; i++) {
    flags[names[i]] = 1 << i;
  }
  return flags;
}

/**
 * Combines multiple flags into a single number.
 * @param flags - Flags to combine.
 * @returns Combined flag value.
 */
export function combine(...flags: number[]): number {
  return flags.reduce((a, b) => a | b, 0);
}

/**
 * Checks if a value has a specific flag.
 * @param value - Value to check.
 * @param flag - Flag to check for.
 * @returns True if the flag is present.
 */
export function has(value: number, flag: number): boolean {
  return (value & flag) !== 0;
}

/**
 * Toggles a flag in a value.
 * @param value - Value to toggle.
 * @param flag - Flag to toggle.
 * @returns New value with the flag toggled.
 */
export function toggle(value: number, flag: number): number {
  return value ^ flag;
}

/**
 * Converts a flag value to an array of names.
 * @param value - Flag value.
 * @param flags - Flag object created by createFlags.
 * @returns Array of names corresponding to set flags.
 */
export function toNames(value: number, flags: Record<string, number>): string[] {
  return Object.keys(flags).filter(key => has(value, flags[key]));
}