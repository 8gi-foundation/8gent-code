/**
 * bitmask-flags.ts
 *
 * Type-safe bitmask flag operations for permission-style flags.
 * defineFlags(names) creates typed flag constants.
 * Flags class provides set, unset, toggle, has, hasAll, hasAny, toString, toArray.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type FlagName<T extends readonly string[]> = T[number];

export type FlagMap<T extends readonly string[]> = {
  readonly [K in T[number]]: number;
};

export interface FlagDef<T extends readonly string[]> {
  flags: FlagMap<T>;
  names: T;
  NONE: 0;
  ALL: number;
}

// ─── defineFlags ─────────────────────────────────────────────────────────────

/**
 * Creates typed flag constants from an array of flag names.
 * Each flag is assigned a unique power-of-2 bitmask value.
 *
 * @example
 * const { flags, NONE, ALL } = defineFlags(['READ', 'WRITE', 'EXEC'] as const);
 * flags.READ  // 1
 * flags.WRITE // 2
 * flags.EXEC  // 4
 * ALL         // 7
 */
export function defineFlags<T extends readonly string[]>(names: T): FlagDef<T> {
  if (names.length > 30) {
    throw new RangeError(
      `defineFlags: max 30 flags supported (got ${names.length})`
    );
  }

  const flags = {} as Record<string, number>;
  let all = 0;

  for (let i = 0; i < names.length; i++) {
    const bit = 1 << i;
    flags[names[i]] = bit;
    all |= bit;
  }

  return {
    flags: flags as FlagMap<T>,
    names,
    NONE: 0,
    ALL: all,
  };
}

// ─── Flags class ─────────────────────────────────────────────────────────────

/**
 * Mutable bitmask container.
 * Operate on numeric flags produced by defineFlags().
 *
 * @example
 * const { flags } = defineFlags(['READ', 'WRITE', 'EXEC'] as const);
 * const perms = new Flags(flags.READ | flags.WRITE);
 * perms.has(flags.READ)   // true
 * perms.has(flags.EXEC)   // false
 * perms.set(flags.EXEC);
 * perms.toggle(flags.WRITE);
 * perms.toArray(flags)    // ['READ', 'EXEC']
 */
export class Flags {
  private _value: number;

  constructor(initial = 0) {
    this._value = initial >>> 0; // coerce to unsigned 32-bit
  }

  /** Current raw bitmask value. */
  get value(): number {
    return this._value;
  }

  /** Set one or more flags. */
  set(...bits: number[]): this {
    for (const bit of bits) this._value |= bit;
    return this;
  }

  /** Unset one or more flags. */
  unset(...bits: number[]): this {
    for (const bit of bits) this._value &= ~bit;
    return this;
  }

  /** Toggle one or more flags. */
  toggle(...bits: number[]): this {
    for (const bit of bits) this._value ^= bit;
    return this;
  }

  /** Returns true if ALL of the given bits are set. */
  has(bit: number): boolean {
    return (this._value & bit) === bit;
  }

  /** Returns true if ALL of the given bits are set. */
  hasAll(...bits: number[]): boolean {
    const mask = bits.reduce((acc, b) => acc | b, 0);
    return (this._value & mask) === mask;
  }

  /** Returns true if ANY of the given bits are set. */
  hasAny(...bits: number[]): boolean {
    const mask = bits.reduce((acc, b) => acc | b, 0);
    return (this._value & mask) !== 0;
  }

  /** Clear all flags. */
  clear(): this {
    this._value = 0;
    return this;
  }

  /** Returns a new Flags with the same value (immutable snapshot). */
  clone(): Flags {
    return new Flags(this._value);
  }

  /**
   * Returns the active flag names as a comma-separated string.
   * Requires the FlagMap produced by defineFlags().
   */
  toString<T extends readonly string[]>(flagMap?: FlagMap<T>): string {
    if (!flagMap) return `Flags(0b${this._value.toString(2)})`;
    return this.toArray(flagMap).join(', ') || 'NONE';
  }

  /**
   * Returns an array of active flag names.
   * Requires the FlagMap produced by defineFlags().
   */
  toArray<T extends readonly string[]>(flagMap: FlagMap<T>): Array<T[number]> {
    const result: Array<T[number]> = [];
    for (const [name, bit] of Object.entries(flagMap) as [string, number][]) {
      if (bit !== 0 && (this._value & bit) === bit) {
        result.push(name as T[number]);
      }
    }
    return result;
  }

  /** Serialize to a plain number for storage/transport. */
  toJSON(): number {
    return this._value;
  }

  /** Restore from a serialized number. */
  static fromJSON(value: number): Flags {
    return new Flags(value);
  }
}
