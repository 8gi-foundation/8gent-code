/**
 * Code Review Benchmarks
 *
 * Tests ability to identify issues and suggest improvements.
 */

import type { BenchmarkDefinition } from "../../types";

export const codeReviewBenchmarks: BenchmarkDefinition[] = [
  {
    id: "CR001",
    name: "Security Code Review",
    category: "code-review",
    difficulty: "hard",
    description: "Identify security vulnerabilities and suggest fixes",
    prompt: `Read fixtures/code-review/CR001-security-issues.ts and perform a security review:

1. Identify ALL security vulnerabilities (there are at least 8)
2. For each vulnerability:
   - Name the vulnerability type (e.g., SQL Injection, XSS)
   - Explain the risk
   - Provide the fixed code
3. Rank vulnerabilities by severity (Critical, High, Medium, Low)
4. Provide a summary of security best practices

Format your response as a structured code review with sections for each issue.`,
    fixtures: ["fixtures/code-review/CR001-security-issues.ts"],
    expectedTokens: 2500,
    timeLimit: 120000,
    rubric: {
      correctness: {
        weight: 0.5,
        checks: [
          {
            name: "finds-password-storage",
            description: "Identifies plaintext password storage",
            points: 10,
            validator: "regex",
            config: { pattern: "plain.*text|password.*storage|hash|bcrypt|argon", countMin: 1 },
          },
          {
            name: "finds-code-injection",
            description: "Identifies code injection (eval/Function)",
            points: 15,
            validator: "regex",
            config: { pattern: "eval|injection|Function.*construct|code.*execution", countMin: 1 },
          },
          {
            name: "finds-path-traversal",
            description: "Identifies path traversal vulnerability",
            points: 10,
            validator: "regex",
            config: { pattern: "path.*traversal|directory.*traversal|\\.\\.\\\\|sanitize.*path", countMin: 1 },
          },
          {
            name: "finds-missing-auth",
            description: "Identifies missing authentication",
            points: 10,
            validator: "regex",
            config: { pattern: "auth.*missing|no.*auth|unauth|access.*control", countMin: 1 },
          },
          {
            name: "finds-weak-token",
            description: "Identifies weak token generation",
            points: 10,
            validator: "regex",
            config: { pattern: "Math\\.random|weak.*token|crypto.*random|uuid", countMin: 1 },
          },
          {
            name: "finds-cors-issue",
            description: "Identifies CORS misconfiguration",
            points: 10,
            validator: "regex",
            config: { pattern: "CORS|origin|wildcard|Access-Control", countMin: 1 },
          },
        ],
      },
      codeQuality: {
        weight: 0.25,
        checks: [
          {
            name: "provides-fixes",
            description: "Provides fixed code for each issue",
            points: 15,
            validator: "regex",
            config: { pattern: "```|fix|solution|instead|should", countMin: 5 },
          },
          {
            name: "explains-risks",
            description: "Explains security risks",
            points: 10,
            validator: "regex",
            config: { pattern: "risk|attack|exploit|malicious|vulnerability", countMin: 3 },
          },
        ],
      },
      efficiency: {
        weight: 0.1,
        checks: [
          {
            name: "prioritizes-issues",
            description: "Prioritizes by severity",
            points: 10,
            validator: "regex",
            config: { pattern: "critical|high|medium|low|severity|priority", countMin: 2 },
          },
        ],
      },
      bestPractices: {
        weight: 0.15,
        checks: [
          {
            name: "provides-best-practices",
            description: "Includes security best practices",
            points: 10,
            validator: "regex",
            config: { pattern: "best.*practice|recommend|should.*always|never.*trust", countMin: 2 },
          },
        ],
      },
    },
    validation: {
      syntaxCheck: false,
      typeCheck: false,
      testExecution: false,
      customValidators: [],
    },
  },
  {
    id: "CR002",
    name: "Performance Code Review",
    category: "code-review",
    difficulty: "medium",
    description: "Identify performance issues and suggest optimizations",
    prompt: `Read fixtures/code-review/CR002-performance-issues.ts and perform a performance review:

1. Identify ALL performance issues (there are at least 8)
2. For each issue:
   - Describe the performance problem
   - Explain the Big O complexity impact
   - Provide optimized code
3. Estimate the performance improvement for each fix
4. Prioritize fixes by impact

Format as a structured performance review report.`,
    fixtures: ["fixtures/code-review/CR002-performance-issues.ts"],
    expectedTokens: 2200,
    timeLimit: 120000,
    rubric: {
      correctness: {
        weight: 0.5,
        checks: [
          {
            name: "finds-n-plus-1",
            description: "Identifies N+1 query pattern",
            points: 15,
            validator: "regex",
            config: { pattern: "N\\+1|n\\+1|batch|bulk|one.*query", countMin: 1 },
          },
          {
            name: "finds-repeated-computation",
            description: "Identifies repeated computation",
            points: 10,
            validator: "regex",
            config: { pattern: "repeat|redundant|memo|cache|compute.*once", countMin: 1 },
          },
          {
            name: "finds-string-concat",
            description: "Identifies string concatenation in loop",
            points: 10,
            validator: "regex",
            config: { pattern: "string.*concat|\\+.*loop|join|array.*push", countMin: 1 },
          },
          {
            name: "finds-linear-search",
            description: "Identifies inefficient linear search",
            points: 10,
            validator: "regex",
            config: { pattern: "O\\(n\\)|linear|Map|Set|index|lookup", countMin: 1 },
          },
          {
            name: "finds-memory-leak",
            description: "Identifies potential memory leak",
            points: 10,
            validator: "regex",
            config: { pattern: "memory|leak|unbounded|cache.*size|LRU", countMin: 1 },
          },
        ],
      },
      codeQuality: {
        weight: 0.25,
        checks: [
          {
            name: "provides-complexity-analysis",
            description: "Provides Big O analysis",
            points: 15,
            validator: "regex",
            config: { pattern: "O\\(|complexity|time|space", countMin: 3 },
          },
          {
            name: "provides-optimized-code",
            description: "Provides optimized code",
            points: 10,
            validator: "regex",
            config: { pattern: "```|optimized|improved|better", countMin: 3 },
          },
        ],
      },
      efficiency: {
        weight: 0.15,
        checks: [
          {
            name: "estimates-improvement",
            description: "Estimates performance improvement",
            points: 10,
            validator: "regex",
            config: { pattern: "%|times.*faster|improvement|speedup|reduction", countMin: 1 },
          },
        ],
      },
      bestPractices: {
        weight: 0.1,
        checks: [
          {
            name: "prioritizes-fixes",
            description: "Prioritizes by impact",
            points: 10,
            validator: "regex",
            config: { pattern: "priority|impact|important|first|critical", countMin: 1 },
          },
        ],
      },
    },
    validation: {
      syntaxCheck: false,
      typeCheck: false,
      testExecution: false,
      customValidators: [],
    },
  },
  {
    id: "CR003",
    name: "Code Smells Review",
    category: "code-review",
    difficulty: "medium",
    description: "Identify code smells and suggest refactoring",
    prompt: `Read fixtures/code-review/CR003-code-smells.ts and perform a code quality review:

1. Identify ALL code smells (there are at least 6 types)
2. For each smell:
   - Name the code smell pattern
   - Explain why it's problematic
   - Provide refactored code
3. Apply SOLID principles where relevant
4. Suggest design patterns that could help

Categories to check:
- God functions
- Magic numbers/strings
- Deep nesting
- Duplicate code
- Long parameter lists
- Boolean flag parameters

Format as a detailed refactoring guide.`,
    fixtures: ["fixtures/code-review/CR003-code-smells.ts"],
    expectedTokens: 2500,
    timeLimit: 120000,
    rubric: {
      correctness: {
        weight: 0.5,
        checks: [
          {
            name: "finds-god-function",
            description: "Identifies god function",
            points: 10,
            validator: "regex",
            config: { pattern: "god.*function|too.*many|single.*responsibility|SRP", countMin: 1 },
          },
          {
            name: "finds-magic-numbers",
            description: "Identifies magic numbers/strings",
            points: 10,
            validator: "regex",
            config: { pattern: "magic.*number|hard.*coded|constant|enum", countMin: 1 },
          },
          {
            name: "finds-deep-nesting",
            description: "Identifies deep nesting",
            points: 10,
            validator: "regex",
            config: { pattern: "nest|pyramid|guard|early.*return|flatten", countMin: 1 },
          },
          {
            name: "finds-duplicate-code",
            description: "Identifies duplicate code",
            points: 10,
            validator: "regex",
            config: { pattern: "duplicate|DRY|extract|common|reuse", countMin: 1 },
          },
          {
            name: "finds-parameter-list",
            description: "Identifies long parameter list",
            points: 10,
            validator: "regex",
            config: { pattern: "parameter.*list|options.*object|builder|config", countMin: 1 },
          },
          {
            name: "finds-boolean-flags",
            description: "Identifies boolean flag parameters",
            points: 10,
            validator: "regex",
            config: { pattern: "boolean.*flag|separate.*function|polymorphism|strategy", countMin: 1 },
          },
        ],
      },
      codeQuality: {
        weight: 0.25,
        checks: [
          {
            name: "provides-refactoring",
            description: "Provides refactored code",
            points: 15,
            validator: "regex",
            config: { pattern: "```|refactor|improve|extract|split", countMin: 4 },
          },
          {
            name: "explains-problems",
            description: "Explains why each smell is problematic",
            points: 10,
            validator: "regex",
            config: { pattern: "maintain|test|read|understand|change", countMin: 3 },
          },
        ],
      },
      efficiency: {
        weight: 0.1,
        checks: [
          {
            name: "applies-solid",
            description: "Applies SOLID principles",
            points: 10,
            validator: "regex",
            config: { pattern: "SOLID|single.*responsibility|open.*closed|interface", countMin: 1 },
          },
        ],
      },
      bestPractices: {
        weight: 0.15,
        checks: [
          {
            name: "suggests-patterns",
            description: "Suggests design patterns",
            points: 10,
            validator: "regex",
            config: { pattern: "pattern|strategy|factory|builder|decorator", countMin: 1 },
          },
        ],
      },
    },
    validation: {
      syntaxCheck: false,
      typeCheck: false,
      testExecution: false,
      customValidators: [],
    },
  },
];

export default codeReviewBenchmarks;
