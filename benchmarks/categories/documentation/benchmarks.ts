/**
 * Documentation Benchmarks
 *
 * Tests ability to generate accurate and helpful documentation.
 */

import type { BenchmarkDefinition } from "../../types";

export const documentationBenchmarks: BenchmarkDefinition[] = [
  {
    id: "DOC001",
    name: "Document API Module",
    category: "documentation",
    difficulty: "medium",
    description: "Generate comprehensive JSDoc documentation for an API module",
    prompt: `Read fixtures/documentation/DOC001-api-module.ts and add comprehensive documentation:

Requirements:
1. Add JSDoc comments to ALL public functions and types
2. Include:
   - @description for each function
   - @param with types and descriptions
   - @returns with type and description
   - @throws for error conditions
   - @example with working code examples
3. Document all interfaces and types
4. Add module-level documentation at the top
5. Document error handling behavior
6. Include usage notes for complex functions (batch, getPaginated)

Provide the complete file with all documentation added.`,
    fixtures: ["fixtures/documentation/DOC001-api-module.ts"],
    expectedTokens: 2500,
    timeLimit: 150000,
    rubric: {
      correctness: {
        weight: 0.4,
        checks: [
          {
            name: "has-jsdoc-comments",
            description: "Has JSDoc comments for all functions",
            points: 15,
            validator: "regex",
            config: { pattern: "/\\*\\*[\\s\\S]*?\\*/", countMin: 8 },
          },
          {
            name: "has-param-docs",
            description: "Documents parameters",
            points: 15,
            validator: "regex",
            config: { pattern: "@param", countMin: 10 },
          },
          {
            name: "has-returns-docs",
            description: "Documents return values",
            points: 10,
            validator: "regex",
            config: { pattern: "@returns|@return", countMin: 5 },
          },
          {
            name: "has-examples",
            description: "Includes examples",
            points: 10,
            validator: "regex",
            config: { pattern: "@example", countMin: 3 },
          },
          {
            name: "has-throws",
            description: "Documents errors",
            points: 10,
            validator: "regex",
            config: { pattern: "@throws|@exception|HttpError", countMin: 2 },
          },
        ],
      },
      codeQuality: {
        weight: 0.3,
        checks: [
          {
            name: "accurate-descriptions",
            description: "Descriptions are accurate",
            points: 15,
            validator: "llm",
            config: { prompt: "Are the JSDoc descriptions accurate?", scoreThreshold: 70 },
          },
          {
            name: "type-annotations",
            description: "Types are documented",
            points: 10,
            validator: "regex",
            config: { pattern: "@type|@typedef|:\\s*\\{", countMin: 3 },
          },
        ],
      },
      efficiency: {
        weight: 0.15,
        checks: [
          {
            name: "concise-docs",
            description: "Documentation is concise",
            points: 10,
            validator: "llm",
            config: { prompt: "Is the documentation concise without being verbose?", scoreThreshold: 70 },
          },
        ],
      },
      bestPractices: {
        weight: 0.15,
        checks: [
          {
            name: "module-docs",
            description: "Has module-level documentation",
            points: 10,
            validator: "regex",
            config: { pattern: "@module|@fileoverview|@description[\\s\\S]*API", countMin: 1 },
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
    id: "DOC002",
    name: "Document State Machine",
    category: "documentation",
    difficulty: "hard",
    description: "Generate comprehensive documentation including diagrams",
    prompt: `Read fixtures/documentation/DOC002-state-machine.ts and generate comprehensive documentation:

Requirements:
1. Add JSDoc comments to all public APIs
2. Create a README.md including:
   - Overview and purpose
   - Installation
   - Quick start example
   - API reference
   - State diagram in Mermaid format
   - Common patterns (traffic light, form wizard, etc.)
   - Advanced usage (guards, actions, delayed transitions)
3. Include TypeScript usage examples
4. Document best practices

Output format:
1. First, the fully documented TypeScript file
2. Then, a complete README.md

Focus on making it understandable for someone new to state machines.`,
    fixtures: ["fixtures/documentation/DOC002-state-machine.ts"],
    expectedTokens: 4000,
    timeLimit: 240000,
    rubric: {
      correctness: {
        weight: 0.4,
        checks: [
          {
            name: "has-jsdoc",
            description: "Has JSDoc for all public APIs",
            points: 10,
            validator: "regex",
            config: { pattern: "/\\*\\*[\\s\\S]*?\\*/", countMin: 5 },
          },
          {
            name: "has-readme",
            description: "Includes README content",
            points: 10,
            validator: "regex",
            config: { pattern: "#.*README|Overview|Installation|Quick.*Start", countMin: 2 },
          },
          {
            name: "has-mermaid-diagram",
            description: "Includes Mermaid state diagram",
            points: 15,
            validator: "regex",
            config: { pattern: "```mermaid|stateDiagram|flowchart|graph", countMin: 1 },
          },
          {
            name: "has-examples",
            description: "Includes code examples",
            points: 15,
            validator: "regex",
            config: { pattern: "```typescript|```ts|```js|@example", countMin: 3 },
          },
        ],
      },
      codeQuality: {
        weight: 0.3,
        checks: [
          {
            name: "explains-concepts",
            description: "Explains state machine concepts",
            points: 15,
            validator: "regex",
            config: { pattern: "state|transition|guard|action|context|event", countMin: 10 },
          },
          {
            name: "has-patterns",
            description: "Documents common patterns",
            points: 10,
            validator: "regex",
            config: { pattern: "traffic.*light|form|wizard|loading|auth|toggle", countMin: 2 },
          },
        ],
      },
      efficiency: {
        weight: 0.15,
        checks: [
          {
            name: "progressive-disclosure",
            description: "Uses progressive disclosure (simple to complex)",
            points: 10,
            validator: "llm",
            config: { prompt: "Does the doc progress from simple to complex?", scoreThreshold: 70 },
          },
        ],
      },
      bestPractices: {
        weight: 0.15,
        checks: [
          {
            name: "has-api-reference",
            description: "Has API reference section",
            points: 10,
            validator: "regex",
            config: { pattern: "API.*Reference|Reference|Methods|Functions", countMin: 1 },
          },
          {
            name: "has-best-practices",
            description: "Documents best practices",
            points: 10,
            validator: "regex",
            config: { pattern: "best.*practice|recommend|avoid|should|tip", countMin: 2 },
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

export default documentationBenchmarks;
