/**
 * Sliding window utility for maintaining a window of numbers with sum, min, and max queries.
 */
export class SlidingWindow {
  private buffer: number[];
  private sum: number;
  private readonly size: number;

  /**
   * Creates a new sliding window with the specified size.
   * @param size The maximum number of elements the window can hold.
   */
  constructor(size: number) {
    this.buffer = [];
    this.sum = 0;
    this.size = size;
  }

  /**
   * Adds a new value to the window. If the window is full, the oldest value is removed.
   * @param value The value to add to the window.
   */
  push(value: number): void {
    if (this.buffer.length === this.size) {
      this.sum -= this.buffer.shift();
    }
    this.buffer.push(value);
    this.sum += value;
  }

  /**
   * Returns the sum of the current window.
   * @returns The sum of the current window.
   */
  sum(): number {
    return this.sum;
  }

  /**
   * Returns the minimum value in the current window.
   * @returns The minimum value in the current window.
   */
  min(): number {
    return Math.min(...this.buffer);
  }

  /**
   * Returns the maximum value in the current window.
   * @returns The maximum value in the current window.
   */
  max(): number {
    return Math.max(...this.buffer);
  }

  /**
   * Returns true if the window contains exactly `size` elements.
   * @returns True if the window is full.
   */
  isFull(): boolean {
    return this.buffer.length === this.size;
  }
}