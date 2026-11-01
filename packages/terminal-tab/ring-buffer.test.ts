/**
 * Tests for @8gent/terminal-tab — ring-buffer.
 *
 * Bounded line buffer used to back the scrollback for a terminal tab.
 * Pure data structure — no I/O.
 */

import { describe, expect, it } from "bun:test";
import { RingBuffer } from "./ring-buffer.js";

describe("RingBuffer — basic ops", () => {
	it("starts empty", () => {
		const buf = new RingBuffer(5);
		expect(buf.size).toBe(0);
		expect(buf.toArray()).toEqual([]);
	});

	it("pushes lines and reports size", () => {
		const buf = new RingBuffer(5);
		buf.push("a");
		buf.push("b");
		expect(buf.size).toBe(2);
		expect(buf.toArray()).toEqual(["a", "b"]);
	});

	it("pushMany appends in order", () => {
		const buf = new RingBuffer(10);
		buf.pushMany(["x", "y", "z"]);
		expect(buf.toArray()).toEqual(["x", "y", "z"]);
	});
});

describe("RingBuffer — capacity overflow", () => {
	it("drops oldest entries when over capacity", () => {
		const buf = new RingBuffer(3);
		buf.push("1");
		buf.push("2");
		buf.push("3");
		buf.push("4");
		expect(buf.size).toBe(3);
		expect(buf.toArray()).toEqual(["2", "3", "4"]);
	});

	it("pushMany handles batch overflow correctly", () => {
		const buf = new RingBuffer(3);
		buf.pushMany(["a", "b", "c", "d", "e"]);
		expect(buf.toArray()).toEqual(["c", "d", "e"]);
	});

	it("pushMany of more lines than capacity keeps only the tail", () => {
		const buf = new RingBuffer(2);
		buf.pushMany(["1", "2", "3", "4", "5"]);
		expect(buf.toArray()).toEqual(["4", "5"]);
	});
});

describe("RingBuffer — takeLast", () => {
	it("returns all lines when n exceeds size", () => {
		const buf = new RingBuffer(10);
		buf.pushMany(["a", "b"]);
		expect(buf.takeLast(5)).toEqual(["a", "b"]);
	});

	it("returns the last n lines", () => {
		const buf = new RingBuffer(10);
		buf.pushMany(["a", "b", "c", "d"]);
		expect(buf.takeLast(2)).toEqual(["c", "d"]);
	});

	it("takeLast(0) returns empty array", () => {
		const buf = new RingBuffer(10);
		buf.pushMany(["a", "b"]);
		expect(buf.takeLast(0)).toEqual([]);
	});
});

describe("RingBuffer — clear", () => {
	it("clear() empties the buffer", () => {
		const buf = new RingBuffer(5);
		buf.pushMany(["a", "b", "c"]);
		buf.clear();
		expect(buf.size).toBe(0);
		expect(buf.toArray()).toEqual([]);
	});
});

describe("RingBuffer — capacity validation", () => {
	it("rejects capacity below 1", () => {
		expect(() => new RingBuffer(0)).toThrow();
		expect(() => new RingBuffer(-5)).toThrow();
	});
});
