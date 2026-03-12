/**
 * Test Generation Benchmarks
 *
 * Tests ability to generate comprehensive test suites.
 */

import type { BenchmarkDefinition } from "../../types";

export const testGenerationBenchmarks: BenchmarkDefinition[] = [
  {
    id: "TG001",
    name: "Generate Calculator Tests",
    category: "test-generation",
    difficulty: "easy",
    description: "Generate comprehensive tests for a calculator module",
    prompt: `Read fixtures/test-generation/TG001-calculator.ts and generate a comprehensive test suite:

Requirements:
1. Use Bun test framework (import { test, expect, describe } from 'bun:test')
2. Test all exported functions
3. Include edge cases:
   - Division by zero
   - Zero to negative power
   - Large numbers / overflow
   - Negative numbers
   - Floating point precision
4. Test history functionality
5. Test calculateChain function
6. Aim for 100% code coverage
7. Use proper test organization (describe blocks)

Provide a complete test file that can be run with 'bun test'.`,
    fixtures: ["fixtures/test-generation/TG001-calculator.ts"],
    expectedTokens: 1800,
    timeLimit: 120000,
    rubric: {
      correctness: {
        weight: 0.4,
        checks: [
          {
            name: "uses-bun-test",
            description: "Uses Bun test framework",
            points: 10,
            validator: "regex",
            config: { pattern: "from.*bun:test|bun:test", countMin: 1 },
          },
          {
            name: "tests-all-operations",
            description: "Tests all math operations",
            points: 15,
            validator: "regex",
            config: { pattern: "(add|subtract|multiply|divide|power|modulo)", countMin: 6 },
          },
          {
            name: "tests-edge-cases",
            description: "Tests edge cases",
            points: 15,
            validator: "regex",
            config: { pattern: "zero|negative|overflow|NaN|Infinity|precision", countMin: 3 },
          },
          {
            name: "tests-history",
            description: "Tests history functionality",
            points: 10,
            validator: "regex",
            config: { pattern: "history|getHistory|clearHistory", countMin: 2 },
          },
          {
            name: "tests-chain",
            description: "Tests calculateChain",
            points: 10,
            validator: "regex",
            config: { pattern: "calculateChain|chain", countMin: 1 },
          },
        ],
      },
      codeQuality: {
        weight: 0.25,
        checks: [
          {
            name: "uses-describe-blocks",
            description: "Uses describe blocks for organization",
            points: 10,
            validator: "regex",
            config: { pattern: "describe\\s*\\(", countMin: 2 },
          },
          {
            name: "descriptive-test-names",
            description: "Has descriptive test names",
            points: 10,
            validator: "regex",
            config: { pattern: "should|when|given|returns|throws", countMin: 5 },
          },
        ],
      },
      efficiency: {
        weight: 0.2,
        checks: [
          {
            name: "no-redundant-tests",
            description: "Avoids redundant tests",
            points: 10,
            validator: "llm",
            config: { prompt: "Are there redundant tests?", scoreThreshold: 70 },
          },
        ],
      },
      bestPractices: {
        weight: 0.15,
        checks: [
          {
            name: "tests-errors",
            description: "Tests error conditions",
            points: 10,
            validator: "regex",
            config: { pattern: "toThrow|rejects|error|Error", countMin: 2 },
          },
          {
            name: "uses-expect",
            description: "Uses expect assertions",
            points: 10,
            validator: "regex",
            config: { pattern: "expect\\s*\\(", countMin: 10 },
          },
        ],
      },
    },
    validation: {
      syntaxCheck: true,
      typeCheck: true,
      testExecution: false,
      customValidators: [],
    },
  },
  {
    id: "TG002",
    name: "Generate Auth Service Tests",
    category: "test-generation",
    difficulty: "hard",
    description: "Generate comprehensive tests for an authentication service",
    prompt: `Read fixtures/test-generation/TG002-auth-service.ts and generate a comprehensive test suite:

Requirements:
1. Use Bun test framework
2. Test all auth flows:
   - Registration (valid/invalid email, weak password, duplicate)
   - Login (success, wrong password, lockout after failures)
   - Session validation (valid, expired, invalid)
   - Logout
   - Password change
   - MFA enable
3. Mock time for testing expiration
4. Test security features:
   - Account lockout after failed attempts
   - Lockout duration
   - Session expiration
5. Use beforeEach/afterEach for setup/cleanup
6. Test concurrent scenarios

Provide a complete test file.`,
    fixtures: ["fixtures/test-generation/TG002-auth-service.ts"],
    expectedTokens: 3000,
    timeLimit: 180000,
    rubric: {
      correctness: {
        weight: 0.4,
        checks: [
          {
            name: "tests-registration",
            description: "Tests registration flow",
            points: 15,
            validator: "regex",
            config: { pattern: "register|registration|signup", countMin: 3 },
          },
          {
            name: "tests-login",
            description: "Tests login flow",
            points: 15,
            validator: "regex",
            config: { pattern: "login|authenticate|sign.*in", countMin: 3 },
          },
          {
            name: "tests-session",
            description: "Tests session handling",
            points: 10,
            validator: "regex",
            config: { pattern: "session|validateSession|expire", countMin: 2 },
          },
          {
            name: "tests-lockout",
            description: "Tests account lockout",
            points: 10,
            validator: "regex",
            config: { pattern: "lockout|locked|failed.*attempt|maxFailedAttempts", countMin: 2 },
          },
          {
            name: "tests-mfa",
            description: "Tests MFA functionality",
            points: 10,
            validator: "regex",
            config: { pattern: "mfa|MFA|enableMfa|twoFactor", countMin: 1 },
          },
        ],
      },
      codeQuality: {
        weight: 0.25,
        checks: [
          {
            name: "uses-setup-teardown",
            description: "Uses beforeEach/afterEach",
            points: 10,
            validator: "regex",
            config: { pattern: "beforeEach|afterEach|beforeAll|afterAll", countMin: 1 },
          },
          {
            name: "isolates-tests",
            description: "Tests are isolated",
            points: 10,
            validator: "regex",
            config: { pattern: "resetForTesting|clear|reset|cleanup", countMin: 1 },
          },
        ],
      },
      efficiency: {
        weight: 0.2,
        checks: [
          {
            name: "mocks-time",
            description: "Mocks time for expiration tests",
            points: 10,
            validator: "regex",
            config: { pattern: "mock.*time|Date\\.now|setSystemTime|useFakeTimers", countMin: 1 },
          },
        ],
      },
      bestPractices: {
        weight: 0.15,
        checks: [
          {
            name: "security-tests",
            description: "Includes security-focused tests",
            points: 10,
            validator: "regex",
            config: { pattern: "security|password.*hash|salt|timing|brute.*force", countMin: 1 },
          },
        ],
      },
    },
    validation: {
      syntaxCheck: true,
      typeCheck: true,
      testExecution: false,
      customValidators: [],
    },
  },
  {
    id: "TG003",
    name: "Generate Event Emitter Tests",
    category: "test-generation",
    difficulty: "medium",
    description: "Generate tests for an event emitter including async and concurrency",
    prompt: `Read fixtures/test-generation/TG003-event-emitter.ts and generate a comprehensive test suite:

Requirements:
1. Use Bun test framework
2. Test all methods:
   - on, once, off
   - emit, emitSync
   - waitFor with timeout
   - onAny wildcard
   - removeAllListeners
3. Test async event handling
4. Test error propagation (AggregateError)
5. Test memory safety:
   - Verify handlers are removed
   - Test max listeners warning
   - Test unsubscribe works
6. Test statistics tracking
7. Test concurrent emissions

Provide a complete test file with async tests.`,
    fixtures: ["fixtures/test-generation/TG003-event-emitter.ts"],
    expectedTokens: 2500,
    timeLimit: 150000,
    rubric: {
      correctness: {
        weight: 0.4,
        checks: [
          {
            name: "tests-basic-events",
            description: "Tests on/off/emit",
            points: 15,
            validator: "regex",
            config: { pattern: "\\.(on|off|emit)\\s*\\(", countMin: 5 },
          },
          {
            name: "tests-once",
            description: "Tests once subscription",
            points: 10,
            validator: "regex",
            config: { pattern: "\\.once\\s*\\(|once.*handler|single.*fire", countMin: 2 },
          },
          {
            name: "tests-waitFor",
            description: "Tests waitFor with timeout",
            points: 10,
            validator: "regex",
            config: { pattern: "waitFor|timeout|reject", countMin: 2 },
          },
          {
            name: "tests-async",
            description: "Tests async event handling",
            points: 10,
            validator: "regex",
            config: { pattern: "async|await|Promise", countMin: 3 },
          },
          {
            name: "tests-errors",
            description: "Tests error propagation",
            points: 10,
            validator: "regex",
            config: { pattern: "AggregateError|error|throw|catch", countMin: 2 },
          },
        ],
      },
      codeQuality: {
        weight: 0.25,
        checks: [
          {
            name: "tests-memory",
            description: "Tests memory/cleanup",
            points: 15,
            validator: "regex",
            config: { pattern: "unsubscribe|listenerCount|removeAllListeners|memory", countMin: 2 },
          },
          {
            name: "tests-stats",
            description: "Tests statistics",
            points: 10,
            validator: "regex",
            config: { pattern: "getStats|stats|hits|totalEvents", countMin: 1 },
          },
        ],
      },
      efficiency: {
        weight: 0.2,
        checks: [
          {
            name: "tests-concurrent",
            description: "Tests concurrent scenarios",
            points: 10,
            validator: "regex",
            config: { pattern: "concurrent|parallel|Promise\\.all|multiple.*emit", countMin: 1 },
          },
        ],
      },
      bestPractices: {
        weight: 0.15,
        checks: [
          {
            name: "uses-typed-events",
            description: "Uses typed events in tests",
            points: 10,
            validator: "regex",
            config: { pattern: "TypedEventEmitter<|interface.*Events|type.*Events", countMin: 1 },
          },
        ],
      },
    },
    validation: {
      syntaxCheck: true,
      typeCheck: true,
      testExecution: false,
      customValidators: [],
    },
  },
];

export default testGenerationBenchmarks;
