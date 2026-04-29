/**
 * @8gent/terminal-tab — ring-buffer.ts
 *
 * Bounded FIFO line buffer for terminal scrollback. The TerminalView
 * keeps one of these per tab and re-renders takeLast(viewportRows)
 * on every PTY data event.
 *
 * Pure data structure: no events, no I/O. Implementations of useTerminal
 * own the React state side.
 */

export class RingBuffer {
	private items: string[] = [];

	constructor(public readonly capacity: number) {
		if (!Number.isFinite(capacity) || capacity < 1) {
			throw new Error(`RingBuffer capacity must be >= 1, got ${capacity}`);
		}
	}

	get size(): number {
		return this.items.length;
	}

	push(line: string): void {
		this.items.push(line);
		if (this.items.length > this.capacity) {
			this.items.splice(0, this.items.length - this.capacity);
		}
	}

	pushMany(lines: string[]): void {
		if (lines.length === 0) return;
		this.items.push(...lines);
		if (this.items.length > this.capacity) {
			this.items.splice(0, this.items.length - this.capacity);
		}
	}

	/** Return the last `n` lines without mutating the buffer. */
	takeLast(n: number): string[] {
		if (n <= 0) return [];
		if (n >= this.items.length) return [...this.items];
		return this.items.slice(this.items.length - n);
	}

	toArray(): string[] {
		return [...this.items];
	}

	clear(): void {
		this.items = [];
	}
}
