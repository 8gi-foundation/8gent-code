interface Test {
  name: string;
  fn: Function;
  beforeEach: Function[];
  afterEach: Function[];
}

let tests: Test[] = [];
let currentContext: { beforeEach: Function[], afterEach: Function[] } = { beforeEach: [], afterEach: [] };
let beforeAllFns: Function[] = [];
let afterAllFns: Function[] = [];

/**
 * Registers a test suite.
 * @param name - The name of the suite.
 * @param fn - The function to execute for the suite.
 */
export function describe(name: string, fn: () => void): void {
  const prevContext = currentContext;
  currentContext = { beforeEach: [], afterEach: [] };
  fn();
  currentContext = prevContext;
}

/**
 * Registers a test case.
 * @param name - The name of the test.
 * @param fn - The function to execute for the test.
 */
export function it(name: string, fn: Function): void {
  tests.push({ name, fn, beforeEach: currentContext.beforeEach, afterEach: currentContext.afterEach });
}

/**
 * Registers a test case (alias for it).
 * @param name - The name of the test.
 * @param fn - The function to execute for the test.
 */
export function test(name: string, fn: Function): void {
  it(name, fn);
}

/**
 * Registers a function to run before each test in the current suite.
 * @param fn - The function to execute before each test.
 */
export function beforeEach(fn: Function): void {
  currentContext.beforeEach.push(fn);
}

/**
 * Registers a function to run after each test in the current suite.
 * @param fn - The function to execute after each test.
 */
export function afterEach(fn: Function): void {
  currentContext.afterEach.push(fn);
}

/**
 * Registers a function to run before all tests.
 * @param fn - The function to execute before all tests.
 */
export function beforeAll(fn: Function): void {
  beforeAllFns.push(fn);
}

/**
 * Registers a function to run after all tests.
 * @param fn - The function to execute after all tests.
 */
export function afterAll(fn: Function): void {
  afterAllFns.push(fn);
}

/**
 * Runs all tests and returns the results.
 * @returns An object with passed, failed, and duration.
 */
export async function run(): Promise<{ passed: number, failed: number, duration: number }> {
  let startTime = Date.now();
  let passed = 0;
  let failed = 0;

  // Execute beforeAll
  for (const fn of beforeAllFns) {
    try {
      await fn();
    } catch (e) {
      // Ignore errors in beforeAll
    }
  }

  for (const test of tests) {
    let testStartTime = Date.now();
    let testPassed = true;

    // Execute beforeEach
    for (const fn of test.beforeEach) {
      try {
        await fn();
      } catch (e) {
        // Ignore errors in beforeEach
      }
    }

    try {
      await test.fn();
    } catch (e) {
      testPassed = false;
      failed++;
    }

    if (testPassed) {
      passed++;
    }

    // Execute afterEach
    for (const fn of test.afterEach) {
      try {
        await fn();
      } catch (e) {
        // Ignore errors in afterEach
      }
    }

    const duration = Date.now() - testStartTime;
    console.log(`${testPassed ? 'pass' : 'fail'} ${duration}ms`);
  }

  // Execute afterAll
  for (const fn of afterAllFns) {
    try {
      await fn();
    } catch (e) {
      // Ignore errors in afterAll
    }
  }

  const totalDuration = Date.now() - startTime;
  return { passed, failed, duration: total意图 };
}