/**
 * mini-test-runner.ts
 *
 * Self-contained minimal test runner for validating quarantine tools before
 * promotion into the main tool registry. No external dependencies.
 *
 * API: describe, it, expect, beforeEach, afterEach, run
 */

type TestFn = () => void | Promise<void>;
type HookFn = () => void | Promise<void>;

interface TestCase {
  name: string;
  fn: TestFn;
  suiteName: string;
}

interface TestResult {
  suite: string;
  name: string;
  passed: boolean;
  error?: string;
}

interface Suite {
  name: string;
  beforeEach: HookFn[];
  afterEach: HookFn[];
}

const tests: TestCase[] = [];
const suites: Suite[] = [];
let currentSuite: Suite = { name: "(root)", beforeEach: [], afterEach: [] };

export function describe(name: string, fn: () => void): void {
  const parent = currentSuite;
  currentSuite = { name, beforeEach: [...parent.beforeEach], afterEach: [...parent.afterEach] };
  suites.push(currentSuite);
  fn();
  currentSuite = parent;
}

export function it(name: string, fn: TestFn): void {
  tests.push({ name, fn, suiteName: currentSuite.name });
}

export function beforeEach(fn: HookFn): void {
  currentSuite.beforeEach.push(fn);
}

export function afterEach(fn: HookFn): void {
  currentSuite.afterEach.push(fn);
}

// --- Expect / Matchers ---

class Expectation {
  private negated = false;

  constructor(private actual: unknown) {}

  get not(): this {
    this.negated = !this.negated;
    return this;
  }

  private assert(passed: boolean, message: string): void {
    const result = this.negated ? !passed : passed;
    if (!result) {
      const prefix = this.negated ? "Expected NOT: " : "Expected: ";
      throw new Error(prefix + message);
    }
  }

  toBe(expected: unknown): void {
    this.assert(
      Object.is(this.actual, expected),
      `${JSON.stringify(this.actual)} to be ${JSON.stringify(expected)}`
    );
  }

  toEqual(expected: unknown): void {
    this.assert(
      JSON.stringify(this.actual) === JSON.stringify(expected),
      `${JSON.stringify(this.actual)} to equal ${JSON.stringify(expected)}`
    );
  }

  toThrow(expectedMessage?: string): void {
    let threw = false;
    let errorMsg = "";
    if (typeof this.actual === "function") {
      try {
        (this.actual as () => void)();
      } catch (e) {
        threw = true;
        errorMsg = e instanceof Error ? e.message : String(e);
      }
    }
    const matched = threw && (expectedMessage == null || errorMsg.includes(expectedMessage));
    this.assert(matched, `function to throw${expectedMessage ? ` "${expectedMessage}"` : ""}`);
  }

  toBeTruthy(): void {
    this.assert(Boolean(this.actual), `${JSON.stringify(this.actual)} to be truthy`);
  }

  toBeFalsy(): void {
    this.assert(!Boolean(this.actual), `${JSON.stringify(this.actual)} to be falsy`);
  }
}

export function expect(actual: unknown): Expectation {
  return new Expectation(actual);
}

// --- Runner ---

export async function run(): Promise<boolean> {
  const results: TestResult[] = [];
  const suiteHooks = new Map<string, Suite>();
  for (const s of suites) suiteHooks.set(s.name, s);

  for (const test of tests) {
    const suite = suiteHooks.get(test.suiteName) ?? { name: test.suiteName, beforeEach: [], afterEach: [] };
    let error: string | undefined;
    try {
      for (const hook of suite.beforeEach) await hook();
      await test.fn();
      for (const hook of suite.afterEach) await hook();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    results.push({ suite: test.suiteName, name: test.name, passed: !error, error });
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  for (const r of results) {
    const icon = r.passed ? "  PASS" : "  FAIL";
    console.log(`${icon}  [${r.suite}] ${r.name}`);
    if (r.error) console.log(`        ${r.error}`);
  }

  console.log(`\n${passed} passed, ${failed} failed (${results.length} total)`);
  return failed === 0;
}
