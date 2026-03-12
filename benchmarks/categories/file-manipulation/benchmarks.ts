/**
 * File Manipulation Benchmarks
 *
 * Tests ability to create, edit, and refactor single files.
 */

import type { BenchmarkDefinition } from "../../types";

export const fileManipulationBenchmarks: BenchmarkDefinition[] = [
  {
    id: "FM001",
    name: "Basic Input Validation",
    category: "file-manipulation",
    difficulty: "easy",
    description: "Add input validation to an existing function",
    prompt: `Read the file fixtures/file-manipulation/FM001-basic-edit.ts and add input validation to the createUser function:
- name: must be non-empty string, max 100 characters
- email: must be valid email format
- age: must be positive integer between 0 and 150
Return validation errors if invalid, throw on invalid input.
Only modify the createUser function, keep everything else unchanged.`,
    fixtures: ["fixtures/file-manipulation/FM001-basic-edit.ts"],
    expectedTokens: 800,
    timeLimit: 60000,
    rubric: {
      correctness: {
        weight: 0.4,
        checks: [
          {
            name: "validates-name",
            description: "Validates name is non-empty and max 100 chars",
            points: 15,
            validator: "regex",
            config: { pattern: "name.*length|length.*name|\\!name|name\\s*===\\s*['\"]|trim\\(\\)", countMin: 1 },
          },
          {
            name: "validates-email",
            description: "Validates email format",
            points: 15,
            validator: "regex",
            config: { pattern: "@|email.*\\.test|isEmail|includes\\(['\"]@['\"]\\)", countMin: 1 },
          },
          {
            name: "validates-age",
            description: "Validates age range 0-150",
            points: 15,
            validator: "regex",
            config: { pattern: "age.*<|age.*>|age.*>=|Number\\.isInteger", countMin: 1 },
          },
          {
            name: "syntax-valid",
            description: "Code has valid syntax",
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
            name: "descriptive-errors",
            description: "Provides descriptive error messages",
            points: 10,
            validator: "regex",
            config: { pattern: "throw.*Error|errors?\\.push|invalid|required", countMin: 1 },
          },
          {
            name: "preserves-types",
            description: "Preserves TypeScript types",
            points: 10,
            validator: "regex",
            config: { pattern: ":\\s*User|interface\\s+User", countMin: 1 },
          },
        ],
      },
      efficiency: {
        weight: 0.2,
        checks: [
          {
            name: "early-return",
            description: "Uses early return pattern",
            points: 10,
            validator: "regex",
            config: { pattern: "if.*\\{[\\s\\S]*?(?:throw|return)[\\s\\S]*?\\}", countMin: 1 },
          },
        ],
      },
      bestPractices: {
        weight: 0.15,
        checks: [
          {
            name: "no-any-type",
            description: "Avoids 'any' type",
            points: 10,
            validator: "regex",
            config: { pattern: ":\\s*any", shouldMatch: false },
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
    id: "FM002",
    name: "Refactor Class to Functions",
    category: "file-manipulation",
    difficulty: "medium",
    description: "Convert a class-based implementation to pure functions",
    prompt: `Read fixtures/file-manipulation/FM002-refactor-class.ts and refactor the Calculator class to pure functions:
- Create individual functions: add, subtract, multiply, divide
- Use a pipe/compose pattern for chaining: pipe(10, add(5), multiply(2))
- Maintain the same functionality and error handling
- Export all functions`,
    fixtures: ["fixtures/file-manipulation/FM002-refactor-class.ts"],
    expectedTokens: 1200,
    timeLimit: 90000,
    rubric: {
      correctness: {
        weight: 0.4,
        checks: [
          {
            name: "has-add-function",
            description: "Exports add function",
            points: 10,
            validator: "regex",
            config: { pattern: "export.*function\\s+add|export\\s+const\\s+add", countMin: 1 },
          },
          {
            name: "has-divide-function",
            description: "Exports divide function with error handling",
            points: 10,
            validator: "regex",
            config: { pattern: "divide[\\s\\S]*?(?:===\\s*0|!==\\s*0|throw)", countMin: 1 },
          },
          {
            name: "has-pipe-compose",
            description: "Implements pipe or compose pattern",
            points: 15,
            validator: "regex",
            config: { pattern: "pipe|compose|chain|flow", countMin: 1 },
          },
          {
            name: "syntax-valid",
            description: "Code has valid syntax",
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
            name: "no-class",
            description: "Does not use class keyword",
            points: 15,
            validator: "regex",
            config: { pattern: "\\bclass\\b", shouldMatch: false },
          },
          {
            name: "pure-functions",
            description: "Functions are pure (no this keyword)",
            points: 10,
            validator: "regex",
            config: { pattern: "\\bthis\\.", shouldMatch: false },
          },
        ],
      },
      efficiency: {
        weight: 0.2,
        checks: [
          {
            name: "curried-functions",
            description: "Uses curried functions for chaining",
            points: 10,
            validator: "regex",
            config: { pattern: "=>.*=>|\\(\\w+\\)\\s*=>\\s*\\(", countMin: 1 },
          },
        ],
      },
      bestPractices: {
        weight: 0.15,
        checks: [
          {
            name: "type-annotations",
            description: "Has proper type annotations",
            points: 10,
            validator: "regex",
            config: { pattern: ":\\s*number|:\\s*\\(", countMin: 2 },
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
    id: "FM003",
    name: "Extract Function",
    category: "file-manipulation",
    difficulty: "medium",
    description: "Extract validation logic into a separate function",
    prompt: `Read fixtures/file-manipulation/FM003-extract-function.ts and extract the validation logic:
- Create a validateOrder function that takes an Order and returns { valid: boolean, errors: string[] }
- Move all validation logic from processOrder into validateOrder
- Update processOrder to use validateOrder
- Export both functions`,
    fixtures: ["fixtures/file-manipulation/FM003-extract-function.ts"],
    expectedTokens: 1000,
    timeLimit: 75000,
    rubric: {
      correctness: {
        weight: 0.4,
        checks: [
          {
            name: "has-validate-order",
            description: "Creates validateOrder function",
            points: 20,
            validator: "regex",
            config: { pattern: "function\\s+validateOrder|const\\s+validateOrder", countMin: 1 },
          },
          {
            name: "validate-returns-correct-shape",
            description: "validateOrder returns correct shape",
            points: 15,
            validator: "regex",
            config: { pattern: "valid|errors", countMin: 2 },
          },
          {
            name: "processOrder-uses-validateOrder",
            description: "processOrder calls validateOrder",
            points: 15,
            validator: "regex",
            config: { pattern: "validateOrder\\s*\\(", countMin: 1 },
          },
        ],
      },
      codeQuality: {
        weight: 0.25,
        checks: [
          {
            name: "single-responsibility",
            description: "Each function has single responsibility",
            points: 15,
            validator: "llm",
            config: { prompt: "Does each function have single responsibility?", scoreThreshold: 70 },
          },
        ],
      },
      efficiency: {
        weight: 0.2,
        checks: [
          {
            name: "no-duplicate-validation",
            description: "No duplicate validation code",
            points: 15,
            validator: "llm",
            config: { prompt: "Is validation logic in one place?", scoreThreshold: 70 },
          },
        ],
      },
      bestPractices: {
        weight: 0.15,
        checks: [
          {
            name: "exports-both",
            description: "Exports both functions",
            points: 10,
            validator: "regex",
            config: { pattern: "export.*validateOrder|export.*processOrder", countMin: 2 },
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

export default fileManipulationBenchmarks;
