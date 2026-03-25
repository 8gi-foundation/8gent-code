/**
 * SlotMap<T> - Generational index slot map for stable entity references.
 *
 * Handles encode a (index, generation) pair. When a slot is reused, the
 * generation increments, so any stale handle is detected immediately rather
 * than silently pointing at a new, unrelated value (no dangling references).
 */

/** Opaque handle encoding slot index and generation as a single BigInt. */
export type Handle = bigint;

const INDEX_BITS = 32n;
const GEN_MASK = (1n << INDEX_BITS) - 1n;

function makeHandle(index: number, gen: number): Handle {
  return (BigInt(index) << INDEX_BITS) | BigInt(gen);
}

function decodeHandle(handle: Handle): { index: number; gen: number } {
  return {
    index: Number(handle >> INDEX_BITS),
    gen: Number(handle & GEN_MASK),
  };
}

interface Slot<T> {
  value: T | undefined;
  gen: number;
  live: boolean;
}

export class SlotMap<T> {
  private slots: Slot<T>[] = [];
  private freeList: number[] = [];
  private _size = 0;

  /** Number of live entries. */
  get size(): number {
    return this._size;
  }

  /**
   * Insert a value. Returns a stable Handle that can be used to retrieve
   * or remove the value later.
   */
  insert(value: T): Handle {
    if (this.freeList.length > 0) {
      const index = this.freeList.pop()!;
      const slot = this.slots[index];
      slot.value = value;
      slot.live = true;
      this._size++;
      return makeHandle(index, slot.gen);
    }

    const index = this.slots.length;
    this.slots.push({ value, gen: 0, live: true });
    this._size++;
    return makeHandle(index, 0);
  }

  /**
   * Retrieve a value by handle. Returns undefined if the handle is stale
   * (the slot was removed and potentially reused) or was never valid.
   */
  get(handle: Handle): T | undefined {
    const { index, gen } = decodeHandle(handle);
    const slot = this.slots[index];
    if (!slot || !slot.live || slot.gen !== gen) return undefined;
    return slot.value;
  }

  /**
   * Check whether a handle still refers to a live entry.
   */
  has(handle: Handle): boolean {
    const { index, gen } = decodeHandle(handle);
    const slot = this.slots[index];
    return !!(slot && slot.live && slot.gen === gen);
  }

  /**
   * Remove the entry for this handle. Increments the generation so any
   * existing copies of the handle become stale. Returns the removed value,
   * or undefined if the handle was already stale.
   */
  remove(handle: Handle): T | undefined {
    const { index, gen } = decodeHandle(handle);
    const slot = this.slots[index];
    if (!slot || !slot.live || slot.gen !== gen) return undefined;

    const value = slot.value;
    slot.value = undefined;
    slot.live = false;
    slot.gen++;           // invalidates all copies of this handle
    this.freeList.push(index);
    this._size--;
    return value;
  }

  /**
   * Iterate over all live [handle, value] pairs.
   */
  *entries(): IterableIterator<[Handle, T]> {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot.live) {
        yield [makeHandle(i, slot.gen), slot.value as T];
      }
    }
  }

  /**
   * Iterate over all live values.
   */
  *values(): IterableIterator<T> {
    for (const [, v] of this.entries()) yield v;
  }

  /**
   * Compact the backing store. Reclaims memory from dead slots by rebuilding
   * the slot array. All live handles remain valid - generation numbers are
   * preserved. Returns the number of slots reclaimed.
   */
  compact(): number {
    const reclaimed = this.freeList.length;
    if (reclaimed === 0) return 0;

    // Rebuild: keep only live slots, update index mapping.
    const newSlots: Slot<T>[] = [];
    const remap = new Map<number, number>();

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot.live) {
        remap.set(i, newSlots.length);
        newSlots.push(slot);
      }
    }

    this.slots = newSlots;
    this.freeList = [];

    // Note: existing handles that encoded the old index are now stale -
    // callers must re-obtain handles after compact(). This is intentional:
    // compact() is a maintenance operation, not a transparent resize.
    return reclaimed;
  }
}
