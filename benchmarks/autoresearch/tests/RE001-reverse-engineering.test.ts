/**
 * RE001 — Reverse Engineering: Modified Run-Length Encoding
 *
 * The LLM is given 15 training input/output pairs and must deduce the
 * encoding algorithm, then implement a `transform(input: number[]): number[]`
 * function. Graded on training pair accuracy + 5 holdout pairs.
 *
 * Loads the LLM-generated solution from FIXTURE_PATH env var.
 */
import { describe, test, expect } from "bun:test";
import {
  TRAINING_PAIRS,
  HOLDOUT_PAIRS,
} from "../../fixtures/re-pairs";

const fixturePath = process.env.FIXTURE_PATH ?? process.env.WORK_DIR;
if (!fixturePath) throw new Error("FIXTURE_PATH or WORK_DIR env var required");

// Dynamic import of the LLM-generated module
const mod = await import(fixturePath);

// Flexibly resolve exports: default, transform, solution, encode, solve
const transformFn: (input: number[]) => number[] =
  typeof mod.default === "function"
    ? mod.default
    : mod.transform ??
      mod.solution ??
      mod.encode ??
      mod.solve ??
      mod.run ??
      mod.process;

if (!transformFn || typeof transformFn !== "function") {
  throw new Error(
    "Module must export a function as: default, transform, solution, encode, solve, run, or process"
  );
}

// ── Training Pairs ──────────────────────────────────────────────────────

describe("RE001: Training Pairs", () => {
  TRAINING_PAIRS.forEach((pair, i) => {
    test(`T${i + 1}: ${JSON.stringify(pair.input)} → ${JSON.stringify(pair.output)}`, () => {
      const result = transformFn(pair.input);
      expect(result).toEqual(pair.output);
    });
  });
});

// ── Holdout Pairs ───────────────────────────────────────────────────────

describe("RE001: Holdout Pairs", () => {
  HOLDOUT_PAIRS.forEach((pair, i) => {
    test(`H${i + 1}: input length ${pair.input.length}`, () => {
      const result = transformFn(pair.input);
      expect(result).toEqual(pair.output);
    });
  });
});

// ── Edge Cases ──────────────────────────────────────────────────────────

describe("RE001: Edge Cases", () => {
  test("empty array returns empty array", () => {
    const result = transformFn([]);
    expect(result).toEqual([]);
  });

  test("single element returns [value, 1]", () => {
    const result = transformFn([99]);
    expect(result).toEqual([99, 1]);
  });

  test("output is always a flat number array", () => {
    const result = transformFn([1, 2, 3, 5, 5, 8]);
    expect(Array.isArray(result)).toBe(true);
    result.forEach((v) => expect(typeof v).toBe("number"));
  });

  test("output length is always even", () => {
    // Every element in the encoding is a [value, descriptor] pair
    const inputs = [
      [1, 2, 3],
      [5, 5, 5],
      [7],
      [10, 9, 8, 3, 3],
      [],
    ];
    for (const input of inputs) {
      const result = transformFn(input);
      expect(result.length % 2).toBe(0);
    }
  });
});

// ── Performance ─────────────────────────────────────────────────────────

describe("RE001: Performance", () => {
  test("10,000-element array encodes in under 100ms", () => {
    // Build a 10,000-element array with mixed patterns
    const big: number[] = [];
    for (let i = 0; i < 2000; i++) {
      // Ascending run of 3
      big.push(i * 10, i * 10 + 1, i * 10 + 2);
    }
    // Fill remaining with plateaus
    while (big.length < 10000) {
      big.push(42);
    }

    const start = performance.now();
    const result = transformFn(big);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(100);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length % 2).toBe(0);
  });
});
