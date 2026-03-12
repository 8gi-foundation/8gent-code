/**
 * Bug Fixing Benchmarks
 *
 * Tests ability to identify and fix various types of bugs.
 */

import type { BenchmarkDefinition } from "../../types";

export const bugFixingBenchmarks: BenchmarkDefinition[] = [
  {
    id: "BF001",
    name: "Fix Async Race Condition",
    category: "bug-fixing",
    difficulty: "hard",
    description: "Fix a race condition in concurrent counter updates",
    prompt: `Read fixtures/bug-fixing/BF001-async-race.ts and fix the race condition:

The bug: Multiple concurrent calls to updateCounter can read stale values and overwrite each other's updates.

Requirements:
- Make updateCounter atomic (only one update at a time per counter)
- Use a mutex/lock pattern (no external libraries)
- Maintain async behavior (don't remove the setTimeout)
- Ensure demonstrateBug() returns final value of 10

Provide the complete fixed file.`,
    fixtures: ["fixtures/bug-fixing/BF001-async-race.ts"],
    expectedTokens: 1000,
    timeLimit: 90000,
    rubric: {
      correctness: {
        weight: 0.5,
        checks: [
          {
            name: "has-lock-mechanism",
            description: "Implements locking mechanism",
            points: 20,
            validator: "regex",
            config: { pattern: "lock|mutex|semaphore|queue|pending|await.*while|Promise.*resolve", countMin: 1 },
          },
          {
            name: "preserves-async",
            description: "Preserves async behavior",
            points: 10,
            validator: "regex",
            config: { pattern: "async|await|Promise|setTimeout", countMin: 2 },
          },
          {
            name: "atomic-operation",
            description: "Update is atomic",
            points: 20,
            validator: "regex",
            config: { pattern: "finally|release|unlock|\\.delete", countMin: 1 },
          },
        ],
      },
      codeQuality: {
        weight: 0.2,
        checks: [
          {
            name: "clean-implementation",
            description: "Clean, readable implementation",
            points: 15,
            validator: "llm",
            config: { prompt: "Is the locking code clean and readable?", scoreThreshold: 70 },
          },
        ],
      },
      efficiency: {
        weight: 0.2,
        checks: [
          {
            name: "per-counter-lock",
            description: "Uses per-counter locking (not global)",
            points: 15,
            validator: "regex",
            config: { pattern: "Map|locks\\[|lock\\.get|lockMap", countMin: 1 },
          },
        ],
      },
      bestPractices: {
        weight: 0.1,
        checks: [
          {
            name: "error-safe",
            description: "Lock is released even on error",
            points: 10,
            validator: "regex",
            config: { pattern: "finally|catch", countMin: 1 },
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
    id: "BF002",
    name: "Fix Memory Leak",
    category: "bug-fixing",
    difficulty: "medium",
    description: "Fix a memory leak caused by unclean event subscriptions",
    prompt: `Read fixtures/bug-fixing/BF002-memory-leak.ts and fix the memory leak:

The bug: DataSubscriber's event handlers are never cleaned up in destroy().

Requirements:
- Store handler reference so it can be removed
- Properly remove handler in destroy()
- Consider using WeakRef or cleaning up the global emitter pattern
- Add a way to verify cleanup worked

Provide the complete fixed file.`,
    fixtures: ["fixtures/bug-fixing/BF002-memory-leak.ts"],
    expectedTokens: 900,
    timeLimit: 75000,
    rubric: {
      correctness: {
        weight: 0.5,
        checks: [
          {
            name: "stores-handler-ref",
            description: "Stores reference to handler",
            points: 20,
            validator: "regex",
            config: { pattern: "this\\.handler|private.*handler|boundHandler|handlerRef", countMin: 1 },
          },
          {
            name: "removes-on-destroy",
            description: "Removes handler in destroy()",
            points: 20,
            validator: "regex",
            config: { pattern: "destroy[\\s\\S]*?off\\(|removeEventListener|delete", countMin: 1 },
          },
          {
            name: "syntax-valid",
            description: "Code has valid syntax",
            points: 10,
            validator: "ast",
            config: { language: "typescript", checkType: "syntax" },
          },
        ],
      },
      codeQuality: {
        weight: 0.25,
        checks: [
          {
            name: "uses-bind-or-arrow",
            description: "Properly binds handler context",
            points: 15,
            validator: "regex",
            config: { pattern: "\\.bind\\(this\\)|=>|boundHandler", countMin: 1 },
          },
        ],
      },
      efficiency: {
        weight: 0.15,
        checks: [
          {
            name: "no-closure-leak",
            description: "Avoids closure-based memory leaks",
            points: 10,
            validator: "llm",
            config: { prompt: "Does the code avoid closure-based memory leaks?", scoreThreshold: 70 },
          },
        ],
      },
      bestPractices: {
        weight: 0.1,
        checks: [
          {
            name: "cleanup-verification",
            description: "Provides way to verify cleanup",
            points: 10,
            validator: "regex",
            config: { pattern: "getHandlerCount|listenerCount|size", countMin: 1 },
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
    id: "BF003",
    name: "Fix Null Reference Errors",
    category: "bug-fixing",
    difficulty: "easy",
    description: "Add proper null checks to prevent runtime errors",
    prompt: `Read fixtures/bug-fixing/BF003-null-check.ts and fix all null reference errors:

Bugs:
- getEmailDomain crashes if email is undefined
- getCompanyCity crashes if company or address is undefined
- getFirstTag crashes if tags is undefined or empty
- countTagsWithPrefix crashes if tags is undefined

Requirements:
- Use optional chaining (?.) and nullish coalescing (??) where appropriate
- Return sensible defaults (empty string, 0, etc.)
- Or use Maybe/Option pattern
- Update formatPersonInfo to handle missing data gracefully
- Make all test data cases work without throwing

Provide the complete fixed file.`,
    fixtures: ["fixtures/bug-fixing/BF003-null-check.ts"],
    expectedTokens: 800,
    timeLimit: 60000,
    rubric: {
      correctness: {
        weight: 0.5,
        checks: [
          {
            name: "uses-optional-chaining",
            description: "Uses optional chaining",
            points: 15,
            validator: "regex",
            config: { pattern: "\\?\\.", countMin: 3 },
          },
          {
            name: "uses-nullish-coalescing",
            description: "Uses nullish coalescing or defaults",
            points: 15,
            validator: "regex",
            config: { pattern: "\\?\\?|\\|\\||\\?\\s*:", countMin: 2 },
          },
          {
            name: "handles-all-cases",
            description: "Handles all null cases",
            points: 20,
            validator: "regex",
            config: { pattern: "(\\?\\..*){3,}|Optional|Maybe|if.*null|if.*undefined", countMin: 1 },
          },
        ],
      },
      codeQuality: {
        weight: 0.25,
        checks: [
          {
            name: "consistent-style",
            description: "Uses consistent null-handling style",
            points: 15,
            validator: "llm",
            config: { prompt: "Is null handling style consistent?", scoreThreshold: 70 },
          },
        ],
      },
      efficiency: {
        weight: 0.15,
        checks: [
          {
            name: "no-excessive-checks",
            description: "Doesn't over-check (uses ?. efficiently)",
            points: 10,
            validator: "llm",
            config: { prompt: "Are null checks efficient without redundancy?", scoreThreshold: 70 },
          },
        ],
      },
      bestPractices: {
        weight: 0.1,
        checks: [
          {
            name: "type-narrowing",
            description: "Uses TypeScript type narrowing",
            points: 10,
            validator: "regex",
            config: { pattern: "if\\s*\\(.*\\)|typeof|instanceof|in\\s+", countMin: 1 },
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
    id: "BF004",
    name: "Fix Off-by-One Errors",
    category: "bug-fixing",
    difficulty: "medium",
    description: "Fix multiple off-by-one errors in array operations",
    prompt: `Read fixtures/bug-fixing/BF004-off-by-one.ts and fix all off-by-one errors:

Bugs to fix:
1. range(1, 5) should return [1, 2, 3, 4, 5] (inclusive)
2. getLastN([1,2,3,4,5], 3) should return [3, 4, 5]
3. paginate([1,2,3,4,5], 1, 2) should return [1, 2] (page 1, 1-indexed)
4. findMiddle([1,2,3,4]) should return [2, 3] (middle two for even length)
5. binarySearch should work without infinite loop

Requirements:
- Fix each function to match expected behavior
- Add boundary checks where needed
- Ensure runTests() passes

Provide the complete fixed file.`,
    fixtures: ["fixtures/bug-fixing/BF004-off-by-one.ts"],
    expectedTokens: 1100,
    timeLimit: 90000,
    rubric: {
      correctness: {
        weight: 0.6,
        checks: [
          {
            name: "range-fixed",
            description: "range() returns inclusive range",
            points: 12,
            validator: "regex",
            config: { pattern: "<=\\s*end|end\\s*\\+\\s*1|start.*end.*inclusive", countMin: 1 },
          },
          {
            name: "getLastN-fixed",
            description: "getLastN() returns correct slice",
            points: 12,
            validator: "regex",
            config: { pattern: "slice\\(-|length\\s*-\\s*n|<\\s*arr\\.length", countMin: 1 },
          },
          {
            name: "paginate-fixed",
            description: "paginate() uses 1-indexed pages",
            points: 12,
            validator: "regex",
            config: { pattern: "page\\s*-\\s*1|\\(page\\s*-|pageIndex", countMin: 1 },
          },
          {
            name: "findMiddle-fixed",
            description: "findMiddle() returns correct middle",
            points: 12,
            validator: "regex",
            config: { pattern: "mid\\s*-\\s*1|floor.*-\\s*1|mid.*mid\\s*\\+", countMin: 1 },
          },
          {
            name: "binarySearch-fixed",
            description: "binarySearch() terminates correctly",
            points: 12,
            validator: "regex",
            config: { pattern: "left\\s*\\+\\s*1|mid\\s*\\+\\s*1|mid\\s*-\\s*1|<=", countMin: 1 },
          },
        ],
      },
      codeQuality: {
        weight: 0.2,
        checks: [
          {
            name: "clear-logic",
            description: "Logic is clear and readable",
            points: 10,
            validator: "llm",
            config: { prompt: "Is the loop/indexing logic clear?", scoreThreshold: 70 },
          },
        ],
      },
      efficiency: {
        weight: 0.1,
        checks: [
          {
            name: "no-extra-iterations",
            description: "No unnecessary iterations",
            points: 10,
            validator: "llm",
            config: { prompt: "Are loops efficient without extra iterations?", scoreThreshold: 70 },
          },
        ],
      },
      bestPractices: {
        weight: 0.1,
        checks: [
          {
            name: "boundary-checks",
            description: "Has proper boundary checks",
            points: 10,
            validator: "regex",
            config: { pattern: "if.*length|if.*<\\s*0|if.*>\\s*", countMin: 1 },
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

export default bugFixingBenchmarks;
