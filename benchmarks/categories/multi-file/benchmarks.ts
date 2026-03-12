/**
 * Multi-File Benchmarks
 *
 * Tests ability to coordinate changes across multiple files.
 */

import type { BenchmarkDefinition } from "../../types";

export const multiFileBenchmarks: BenchmarkDefinition[] = [
  {
    id: "MF001",
    name: "Add Error Handling Across Files",
    category: "multi-file",
    difficulty: "hard",
    description: "Add comprehensive error handling and retry logic across an API client module",
    prompt: `Read all files in fixtures/multi-file/MF001-api-client/ and add error handling:

1. In types.ts:
   - Add ApiError interface with code, message, status, retryable fields
   - Add RetryConfig interface with maxRetries, delay, backoff fields

2. In client.ts:
   - Add retry logic with exponential backoff
   - Add timeout handling
   - Throw typed errors (ApiError)
   - Add request/response interceptors

3. In users.ts and posts.ts:
   - Wrap all methods with try-catch
   - Return typed Results (Success<T> | Error<ApiError>)
   - Add method-specific error messages

4. In index.ts:
   - Add createApiWithRetry factory function
   - Export error types

Return all modified files with their full content.`,
    fixtures: [
      "fixtures/multi-file/MF001-api-client/types.ts",
      "fixtures/multi-file/MF001-api-client/client.ts",
      "fixtures/multi-file/MF001-api-client/users.ts",
      "fixtures/multi-file/MF001-api-client/posts.ts",
      "fixtures/multi-file/MF001-api-client/index.ts",
    ],
    expectedTokens: 3500,
    timeLimit: 180000,
    rubric: {
      correctness: {
        weight: 0.4,
        checks: [
          {
            name: "has-api-error-type",
            description: "Defines ApiError interface",
            points: 10,
            validator: "regex",
            config: { pattern: "interface\\s+ApiError|type\\s+ApiError", countMin: 1 },
          },
          {
            name: "has-retry-logic",
            description: "Implements retry with backoff",
            points: 15,
            validator: "regex",
            config: { pattern: "retry|backoff|attempt|maxRetries", countMin: 2 },
          },
          {
            name: "has-timeout",
            description: "Implements timeout handling",
            points: 10,
            validator: "regex",
            config: { pattern: "timeout|AbortController|signal", countMin: 1 },
          },
          {
            name: "has-try-catch",
            description: "Uses try-catch for error handling",
            points: 10,
            validator: "regex",
            config: { pattern: "try\\s*\\{", countMin: 3 },
          },
          {
            name: "syntax-valid",
            description: "All files have valid syntax",
            points: 15,
            validator: "ast",
            config: { language: "typescript", checkType: "syntax" },
          },
        ],
      },
      codeQuality: {
        weight: 0.25,
        checks: [
          {
            name: "consistent-error-format",
            description: "Uses consistent error format across files",
            points: 15,
            validator: "regex",
            config: { pattern: "ApiError|Result<", countMin: 3 },
          },
          {
            name: "typed-errors",
            description: "Errors are properly typed",
            points: 10,
            validator: "regex",
            config: { pattern: ":\\s*ApiError|as\\s+ApiError|extends\\s+Error", countMin: 1 },
          },
        ],
      },
      efficiency: {
        weight: 0.2,
        checks: [
          {
            name: "exponential-backoff",
            description: "Uses exponential backoff for retries",
            points: 15,
            validator: "regex",
            config: { pattern: "\\*\\s*2|Math\\.pow|\\*\\*|exponential", countMin: 1 },
          },
        ],
      },
      bestPractices: {
        weight: 0.15,
        checks: [
          {
            name: "exports-types",
            description: "Exports error types",
            points: 10,
            validator: "regex",
            config: { pattern: "export.*ApiError|export.*Result", countMin: 1 },
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
    id: "MF002",
    name: "Add Feature Flag System",
    category: "multi-file",
    difficulty: "expert",
    description: "Add a feature flag system across multiple components",
    prompt: `Create a feature flag system with these files:

1. feature-flags/types.ts:
   - FeatureFlag interface with name, enabled, conditions, rollout fields
   - FlagCondition for user-based, time-based, percentage rollouts
   - FlagContext for evaluation context

2. feature-flags/evaluator.ts:
   - evaluateFlag(flag, context) function
   - Support percentage rollout with consistent hashing
   - Support time-based flags (start/end dates)
   - Support user segment targeting

3. feature-flags/provider.ts:
   - FeatureFlagProvider class
   - loadFlags() from config/remote
   - getFlag(name) method
   - isEnabled(name, context) method
   - subscribe to flag changes

4. feature-flags/hooks.ts (React hooks):
   - useFeatureFlag(name) hook
   - useFeatureFlags() hook for multiple flags
   - FeatureFlagContext and Provider component

5. feature-flags/index.ts:
   - Export everything
   - Default provider instance

Ensure type safety throughout and handle edge cases.`,
    fixtures: [],
    expectedTokens: 4000,
    timeLimit: 240000,
    rubric: {
      correctness: {
        weight: 0.4,
        checks: [
          {
            name: "has-all-files",
            description: "Creates all required files",
            points: 15,
            validator: "regex",
            config: { pattern: "types\\.ts|evaluator\\.ts|provider\\.ts|hooks\\.ts|index\\.ts", countMin: 5 },
          },
          {
            name: "has-evaluate-flag",
            description: "Implements flag evaluation",
            points: 15,
            validator: "regex",
            config: { pattern: "evaluateFlag|isEnabled", countMin: 1 },
          },
          {
            name: "has-rollout-logic",
            description: "Implements percentage rollout",
            points: 10,
            validator: "regex",
            config: { pattern: "percentage|rollout|hash|random", countMin: 1 },
          },
          {
            name: "has-react-hooks",
            description: "Implements React hooks",
            points: 10,
            validator: "regex",
            config: { pattern: "useFeatureFlag|useState|useContext", countMin: 2 },
          },
        ],
      },
      codeQuality: {
        weight: 0.25,
        checks: [
          {
            name: "type-safe",
            description: "Uses proper TypeScript types",
            points: 15,
            validator: "regex",
            config: { pattern: "interface|type\\s+\\w+|<T>|generic", countMin: 5 },
          },
          {
            name: "consistent-api",
            description: "Consistent API design",
            points: 10,
            validator: "llm",
            config: { prompt: "Is the API design consistent?", scoreThreshold: 70 },
          },
        ],
      },
      efficiency: {
        weight: 0.2,
        checks: [
          {
            name: "caching",
            description: "Caches flag evaluations",
            points: 10,
            validator: "regex",
            config: { pattern: "cache|memo|Map|WeakMap", countMin: 1 },
          },
        ],
      },
      bestPractices: {
        weight: 0.15,
        checks: [
          {
            name: "error-handling",
            description: "Handles errors gracefully",
            points: 10,
            validator: "regex",
            config: { pattern: "try|catch|fallback|default", countMin: 2 },
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

export default multiFileBenchmarks;
