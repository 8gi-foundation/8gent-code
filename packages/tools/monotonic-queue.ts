/**
 * Monotonic deque for sliding window min/max in O(1).
 * @template T
 */
export class MonotonicQueue<T> {
    private deque: T[] = [];

    /**
     * @param compare - Function to determine monotonic order.
     * For min: (a, b) => a < b
     * For max: (a, b) => a > b
     */
    constructor(private compare: (a: T, b: T) => boolean) {}

    /**
     * Add value to the deque maintaining monotonic order.
     * @param value - Value to add.
     */
    push(value: T): void {
        while (this.deque.length > 0 && this.compare(value, this.deque[this.deque.length - 1])) {
            this.deque.pop();
        }
        this.deque.push(value);
    }

    /**
     * Get current optimum (front of deque).
     * @returns Optimum value or undefined if empty.
     */
    front(): T | undefined {
        return this.deque[0];
    }

    /**
     * Remove oldest element (front of deque).
     */
    pop(): void {
        if (this.deque.length > 0) {
            this.deque.shift();
        }
    }
}