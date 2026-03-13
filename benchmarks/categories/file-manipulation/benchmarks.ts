import type { BenchmarkDefinition } from "../../types";

export const fileManipulationBenchmarks: BenchmarkDefinition[] = [
  {
    id: "FM001",
    category: "file-manipulation",
    title: "Input Validation with Structured Errors",
    difficulty: "medium",
    prompt: `Implement a validateInput function that validates user registration data and returns structured errors.

\`\`\`typescript
interface RegistrationInput {
  name: string;
  email: string;
  age: number;
  password?: string;
}

interface ValidationResult {
  valid: boolean;
  errors: { field: string; message: string }[];
}

function validateInput(input: RegistrationInput): ValidationResult {
  // Implement this
}
\`\`\`

Validation rules:
1. name: required, non-empty after trim, max 100 chars
2. email: required, must contain "@" and ".", no spaces
3. age: required, must be integer >= 0 and <= 150
4. password: optional, but if provided must be >= 8 chars

Return { valid: true, errors: [] } if all pass, or { valid: false, errors: [...] } with one entry per failed rule.
Each error entry: { field: "fieldName", message: "human readable message" }

Provide the full function as a single code block.`,
    keywords: ["validate", "errors", "field", "message", "valid", "name", "email", "age", "trim", "includes"],
    keywordThreshold: 5,
    testExecution: true,
    testFile: "autoresearch/tests/FM001-validation.test.ts",
    timeoutMs: 10000,
  },
];
