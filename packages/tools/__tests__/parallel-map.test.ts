/**
 * Behavior tests for packages/tools/parallel-map.ts.
 *
 * parallel-map supersedes the deleted packages/tools/async-pool.ts: it is
 * the same concurrency-limited pool plus AbortSignal support and
 * filter/forEach/reduce variants. These tests use deferred-promise
 * fixtures and in-flight counters - no sleeps, no timing assumptions.
 *
 * Note: async-pool's `allSettled` mode has no equivalent here; parallel-map
 * is fail-fast only. No callers depended on either module before this file
 * existed, so nothing lost that behavior.
 */

import { describe, expect, test } from "bun:test";
import { parallelFilter, parallelForEach, parallelMap, parallelReduce } from "../parallel-map";

/** A promise with its resolve/reject handles exposed. */
function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (err: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Yield to the microtask queue so in-flight callbacks can start. */
function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("parallelMap", () => {
	test("preserves input order even when items complete out of order", async () => {
		const items = [0, 1, 2, 3, 4];
		const gates = items.map(() => deferred<void>());
		const running = parallelMap(items, async (item) => {
			await gates[item].promise;
			return item * 10;
		}, 5);

		// Release in reverse completion order.
		for (const gate of [...gates].reverse()) gate.resolve();

		expect(await running).toEqual([0, 10, 20, 30, 40]);
	});

	test("never exceeds the concurrency limit", async () => {
		const concurrency = 3;
		const items = Array.from({ length: 10 }, (_, i) => i);
		const gates = items.map(() => deferred<void>());
		let inFlight = 0;
		let maxInFlight = 0;
		let started = 0;

		const running = parallelMap(items, async (item) => {
			started++;
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await gates[item].promise;
			inFlight--;
			return item;
		}, concurrency);

		await tick();
		// Only the first `concurrency` callbacks may have started.
		expect(started).toBe(concurrency);
		expect(maxInFlight).toBe(concurrency);

		// Releasing one slot admits exactly one more item.
		gates[0].resolve();
		await tick();
		expect(started).toBe(concurrency + 1);

		for (const gate of gates) gate.resolve();
		expect(await running).toEqual(items);
		expect(maxInFlight).toBe(concurrency);
	});

	test("rejects fast on the first error", async () => {
		const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
		const boom = new Error("boom");
		const running = parallelMap([0, 1, 2], async (item) => {
			await gates[item].promise;
			if (item === 1) throw boom;
			return item;
		}, 3);

		// Fail item 1 while 0 and 2 are still pending: must reject without
		// waiting for the other in-flight items to settle.
		gates[1].reject(boom);
		await expect(running).rejects.toBe(boom);
		gates[0].resolve();
		gates[2].resolve();
	});

	test("aborts mid-flight with an AbortError and stops admitting items", async () => {
		const controller = new AbortController();
		const started: number[] = [];
		const gates = Array.from({ length: 6 }, () => deferred<void>());

		const running = parallelMap(
			[0, 1, 2, 3, 4, 5],
			async (item) => {
				started.push(item);
				await gates[item].promise;
				return item;
			},
			2,
			controller.signal,
		);

		await tick();
		expect(started).toEqual([0, 1]);

		controller.abort();
		gates[0].resolve();
		gates[1].resolve();

		const err = await running.then(
			() => null,
			(e) => e,
		);
		expect(err).toBeInstanceOf(DOMException);
		expect((err as DOMException).name).toBe("AbortError");
		await tick();
		// No new items were admitted after the abort.
		expect(started).toEqual([0, 1]);
	});

	test("rejects immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		let called = false;
		const err = await parallelMap(
			[1, 2, 3],
			async () => {
				called = true;
				return 0;
			},
			2,
			controller.signal,
		).then(
			() => null,
			(e) => e,
		);
		expect((err as DOMException).name).toBe("AbortError");
		expect(called).toBe(false);
	});

	test("propagates a custom abort reason", async () => {
		const controller = new AbortController();
		const reason = new Error("session torn down");
		const gate = deferred<void>();
		const running = parallelMap([1, 2], async () => {
			await gate.promise;
			return 0;
		}, 1, controller.signal);
		controller.abort(reason);
		gate.resolve();
		await expect(running).rejects.toBe(reason);
	});

	test("handles an empty array without invoking the callback", async () => {
		let called = false;
		const result = await parallelMap([], async () => {
			called = true;
			return 0;
		});
		expect(result).toEqual([]);
		expect(called).toBe(false);
	});

	test("passes item index to the callback", async () => {
		const result = await parallelMap(["a", "b", "c"], async (item, index) => `${item}${index}`, 2);
		expect(result).toEqual(["a0", "b1", "c2"]);
	});
});

describe("parallelFilter", () => {
	test("keeps passing items in original order", async () => {
		const items = [1, 2, 3, 4, 5, 6];
		const gates = items.map(() => deferred<void>());
		const running = parallelFilter(items, async (item, index) => {
			await gates[index].promise;
			return item % 2 === 0;
		}, 6);
		for (const gate of [...gates].reverse()) gate.resolve();
		expect(await running).toEqual([2, 4, 6]);
	});
});

describe("parallelForEach", () => {
	test("visits every item under the concurrency limit", async () => {
		const seen: number[] = [];
		let inFlight = 0;
		let maxInFlight = 0;
		await parallelForEach([1, 2, 3, 4, 5], async (item) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await Promise.resolve();
			seen.push(item);
			inFlight--;
		}, 2);
		expect(seen.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
		expect(maxInFlight).toBeLessThanOrEqual(2);
	});
});

describe("parallelReduce", () => {
	test("sequential path (concurrency 1) reduces in order", async () => {
		const order: number[] = [];
		const result = await parallelReduce(
			[1, 2, 3, 4],
			async (acc, item) => {
				order.push(item);
				return acc + item;
			},
			0,
			1,
		);
		expect(result).toBe(10);
		expect(order).toEqual([1, 2, 3, 4]);
	});

	test("parallel path reduces associatively to the same total", async () => {
		const items = Array.from({ length: 20 }, (_, i) => i + 1);
		const result = await parallelReduce(items, async (acc, item) => acc + item, 0, 4);
		expect(result).toBe(210);
	});

	test("returns init for an empty array", async () => {
		const result = await parallelReduce([], async (acc: number) => acc, 42, 4);
		expect(result).toBe(42);
	});
});
