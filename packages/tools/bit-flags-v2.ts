/**
 * bit-flags-v2 - Enhanced named bit flags with typed flag set operations.
 *
 * Usage:
 *   const Perms = createFlags({ READ: 1, WRITE: 2, EXEC: 4 });
 *   const f = Perms.create(Perms.READ | Perms.WRITE);
 *   f.has(Perms.READ);   // true
 *   f.toString();        // "READ|WRITE"
 */

export type FlagDef = Record<string, number>;

export type FlagValues<T extends FlagDef> = { readonly [K in keyof T]: T[K] };

export interface FlagSet<T extends FlagDef> {
  /** Add one or more flags. Returns a new FlagSet. */
  add(flag: number): FlagSet<T>;
  /** Remove one or more flags. Returns a new FlagSet. */
  remove(flag: number): FlagSet<T>;
  /** Check if all bits of flag are set. */
  has(flag: number): boolean;
  /** Check if all provided flags are set. */
  hasAll(...flags: number[]): boolean;
  /** Check if any of the provided flags are set. */
  hasAny(...flags: number[]): boolean;
  /** Toggle flag bits. Returns a new FlagSet. */
  toggle(flag: number): FlagSet<T>;
  /** Raw numeric value. */
  valueOf(): number;
  /** Named representation, e.g. "READ|WRITE". Returns "NONE" when 0. */
  toString(): string;
  /** Array of active flag names. */
  toArray(): (keyof T)[];
}

export interface FlagRegistry<T extends FlagDef> extends FlagValues<T> {
  /** Create a FlagSet from an initial numeric value (default 0). */
  create(initial?: number): FlagSet<T>;
  /** Named list of all defined flag names. */
  names(): (keyof T)[];
  /** All defined flag values combined (universe). */
  all(): number;
  /** Zero / empty flag set. */
  none(): FlagSet<T>;
}

function makeFlagSet<T extends FlagDef>(
  defs: T,
  reverseMap: Map<number, keyof T>,
  value: number
): FlagSet<T> {
  const self: FlagSet<T> = {
    add: (flag) => makeFlagSet(defs, reverseMap, value | flag),
    remove: (flag) => makeFlagSet(defs, reverseMap, value & ~flag),
    has: (flag) => (value & flag) === flag,
    hasAll: (...flags) => flags.every((f) => (value & f) === f),
    hasAny: (...flags) => flags.some((f) => (value & f) !== 0),
    toggle: (flag) => makeFlagSet(defs, reverseMap, value ^ flag),
    valueOf: () => value,
    toString: () => {
      if (value === 0) return "NONE";
      const active: string[] = [];
      for (const [bit, name] of reverseMap) {
        if (bit !== 0 && (value & bit) === bit) {
          active.push(String(name));
        }
      }
      return active.length > 0 ? active.join("|") : String(value);
    },
    toArray: () => {
      const active: (keyof T)[] = [];
      for (const [bit, name] of reverseMap) {
        if (bit !== 0 && (value & bit) === bit) {
          active.push(name);
        }
      }
      return active;
    },
  };
  return self;
}

/**
 * Create a named bit-flag registry.
 *
 * @param defs - Object mapping flag names to power-of-two values, e.g. { READ: 1, WRITE: 2, EXEC: 4 }
 * @returns FlagRegistry with all flag constants plus create/names/all/none helpers.
 *
 * @example
 * const Perms = createFlags({ READ: 1, WRITE: 2, EXEC: 4 });
 * const rw = Perms.create(Perms.READ | Perms.WRITE);
 * rw.has(Perms.READ);     // true
 * rw.hasAll(Perms.READ, Perms.WRITE); // true
 * rw.hasAny(Perms.EXEC);  // false
 * rw.toggle(Perms.EXEC).toString(); // "READ|WRITE|EXEC"
 * rw.remove(Perms.WRITE).toArray(); // ["READ"]
 */
export function createFlags<T extends FlagDef>(defs: T): FlagRegistry<T> {
  // Build reverse lookup: bit -> name (single-bit values only for clean display)
  const reverseMap = new Map<number, keyof T>();
  for (const key of Object.keys(defs) as (keyof T)[]) {
    const bit = defs[key];
    // Only register single-bit values for clean toString; composites are derived
    const isPowerOfTwo = bit !== 0 && (bit & (bit - 1)) === 0;
    if (isPowerOfTwo) {
      reverseMap.set(bit, key);
    }
  }

  const create = (initial = 0): FlagSet<T> =>
    makeFlagSet(defs, reverseMap, initial);

  const universe = Object.values(defs).reduce<number>((acc, v) => acc | v, 0);

  const registry = {
    create,
    names: () => Object.keys(defs) as (keyof T)[],
    all: () => universe,
    none: () => create(0),
    ...defs,
  } as FlagRegistry<T>;

  return registry;
}

export default createFlags;
