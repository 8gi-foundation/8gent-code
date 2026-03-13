/**
 * BF001 — Race Condition in Shared Counter
 *
 * Loads the LLM-generated fix from FIXTURE_PATH env var,
 * then verifies concurrency correctness.
 */
import { describe, test, expect, beforeEach } from "bun:test";

const fixturePath = process.env.FIXTURE_PATH;
if (!fixturePath) throw new Error("FIXTURE_PATH env var required");

// Dynamic import of the LLM-generated module
const mod = await import(fixturePath);

// Accept: default export, named SharedCounter, or named FixedCounter
const CounterClass =
  mod.default ?? mod.SharedCounter ?? mod.FixedCounter ?? mod.Counter;

if (!CounterClass) {
  throw new Error(
    "Module must export SharedCounter, FixedCounter, Counter, or default class"
  );
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("BF001: Race Condition Fix", () => {
  let counter: InstanceType<typeof CounterClass>;

  beforeEach(() => {
    counter = new CounterClass();
  });

  test("10 concurrent increments yield value 10", async () => {
    const promises = Array.from({ length: 10 }, () => counter.increment());
    await Promise.all(promises);
    const val = counter.get?.() ?? counter.value ?? counter.getValue?.();
    expect(val).toBe(10);
  });

  test("5 increments + 3 decrements yield value 2", async () => {
    const ops = [
      ...Array.from({ length: 5 }, () => counter.increment()),
      ...Array.from({ length: 3 }, () => counter.decrement()),
    ];
    await Promise.all(ops);
    const val = counter.get?.() ?? counter.value ?? counter.getValue?.();
    expect(val).toBe(2);
  });

  test("multiple independent counters don't interfere", async () => {
    const a = new CounterClass();
    const b = new CounterClass();

    await Promise.all([
      ...Array.from({ length: 5 }, () => a.increment()),
      ...Array.from({ length: 3 }, () => b.increment()),
    ]);

    const aVal = a.get?.() ?? a.value ?? a.getValue?.();
    const bVal = b.get?.() ?? b.value ?? b.getValue?.();
    expect(aVal).toBe(5);
    expect(bVal).toBe(3);
  });

  test("lock is released even after heavy contention", async () => {
    // Run 50 concurrent increments — if lock leaks, this hangs
    const promises = Array.from({ length: 50 }, () => counter.increment());
    await Promise.all(promises);
    const val = counter.get?.() ?? counter.value ?? counter.getValue?.();
    expect(val).toBe(50);
  });

  test("reset works correctly after concurrent ops", async () => {
    await Promise.all(Array.from({ length: 5 }, () => counter.increment()));
    counter.reset?.();
    const val = counter.get?.() ?? counter.value ?? counter.getValue?.();
    expect(val).toBe(0);
  });
});
