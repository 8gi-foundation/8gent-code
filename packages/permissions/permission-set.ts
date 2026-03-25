/**
 * Unix-style permission bitmask operations for agent tool authorization.
 *
 * Bit layout (per principal):
 *   read  = 4  (0b100)
 *   write = 2  (0b010)
 *   exec  = 1  (0b001)
 *
 * Full 9-bit mask mirrors Unix rwxrwxrwx:
 *   owner  = bits 8-6
 *   group  = bits 5-3
 *   other  = bits 2-0
 */

export const PERM = {
  NONE: 0,
  READ: 4,
  WRITE: 2,
  EXEC: 1,
  READ_WRITE: 6,
  READ_EXEC: 5,
  WRITE_EXEC: 3,
  ALL: 7,
} as const;

export type PermBits = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface PermissionTriple {
  owner: PermBits;
  group: PermBits;
  other: PermBits;
}

function clampBits(n: number): PermBits {
  return (n & 0b111) as PermBits;
}

function bitsToRwx(bits: PermBits): string {
  return (
    (bits & PERM.READ ? "r" : "-") +
    (bits & PERM.WRITE ? "w" : "-") +
    (bits & PERM.EXEC ? "x" : "-")
  );
}

function rwxToBits(rwx: string): PermBits {
  if (rwx.length !== 3) throw new Error(`Invalid rwx segment: "${rwx}"`);
  let bits = 0;
  if (rwx[0] === "r") bits |= PERM.READ;
  if (rwx[1] === "w") bits |= PERM.WRITE;
  if (rwx[2] === "x") bits |= PERM.EXEC;
  return clampBits(bits);
}

export class PermissionSet {
  private mask: number;

  constructor(mask = 0) {
    this.mask = mask & 0o777;
  }

  // --- Factory methods ---

  static fromOctal(octal: number): PermissionSet {
    return new PermissionSet(octal & 0o777);
  }

  static fromString(rwxStr: string): PermissionSet {
    if (rwxStr.length !== 9) {
      throw new Error(`Expected 9-char rwx string (e.g. "rwxr-xr--"), got: "${rwxStr}"`);
    }
    const owner = rwxToBits(rwxStr.slice(0, 3));
    const group = rwxToBits(rwxStr.slice(3, 6));
    const other = rwxToBits(rwxStr.slice(6, 9));
    return PermissionSet.fromTriple({ owner, group, other });
  }

  static fromTriple(triple: PermissionTriple): PermissionSet {
    const mask = (triple.owner << 6) | (triple.group << 3) | triple.other;
    return new PermissionSet(mask);
  }

  // --- Combine / Check ---

  /** OR two sets together (grant union). */
  combine(other: PermissionSet): PermissionSet {
    return new PermissionSet(this.mask | other.mask);
  }

  /** AND check - returns true if this set satisfies all bits in required. */
  allows(required: PermissionSet): boolean {
    return (this.mask & required.mask) === required.mask;
  }

  /** Revoke bits present in the given set (AND NOT). */
  revoke(remove: PermissionSet): PermissionSet {
    return new PermissionSet(this.mask & ~remove.mask);
  }

  /** Intersect two sets (common bits only). */
  intersect(other: PermissionSet): PermissionSet {
    return new PermissionSet(this.mask & other.mask);
  }

  // --- Equality / Comparison ---

  equals(other: PermissionSet): boolean {
    return this.mask === other.mask;
  }

  /** Returns true if this set is a strict superset of other. */
  isSupersetOf(other: PermissionSet): boolean {
    return this.allows(other) && !this.equals(other);
  }

  // --- Accessors ---

  toOctal(): number {
    return this.mask;
  }

  toTriple(): PermissionTriple {
    return {
      owner: clampBits((this.mask >> 6) & 0b111),
      group: clampBits((this.mask >> 3) & 0b111),
      other: clampBits(this.mask & 0b111),
    };
  }

  toString(): string {
    const t = this.toTriple();
    return bitsToRwx(t.owner) + bitsToRwx(t.group) + bitsToRwx(t.other);
  }

  toOctalString(): string {
    return `0o${this.mask.toString(8).padStart(3, "0")}`;
  }
}
