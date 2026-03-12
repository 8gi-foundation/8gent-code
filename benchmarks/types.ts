/**
 * 8gent Code Benchmark Types
 *
 * Type definitions for the comprehensive benchmark suite.
 */

export type BenchmarkCategory =
  | "file-manipulation"
  | "multi-file"
  | "bug-fixing"
  | "feature-implementation"
  | "code-review"
  | "test-generation"
  | "documentation";

export type Difficulty = "easy" | "medium" | "hard" | "expert";

export interface BenchmarkDefinition {
  id: string;
  name: string;
  category: BenchmarkCategory;
  difficulty: Difficulty;
  description: string;
  prompt: string;
  fixtures: string[];
  expectedTokens: number;
  timeLimit: number; // milliseconds
  rubric: GradingRubric;
  validation: ValidationConfig;
}

export interface GradingRubric {
  correctness: RubricCriteria;
  codeQuality: RubricCriteria;
  efficiency: RubricCriteria;
  bestPractices: RubricCriteria;
}

export interface RubricCriteria {
  weight: number; // 0-1, all weights should sum to 1
  checks: RubricCheck[];
}

export interface RubricCheck {
  name: string;
  description: string;
  points: number;
  validator: "regex" | "ast" | "execution" | "manual" | "llm";
  config: Record<string, unknown>;
}

export interface ValidationConfig {
  syntaxCheck: boolean;
  typeCheck: boolean;
  testExecution: boolean;
  customValidators: string[];
}

export interface BenchmarkResult {
  benchmarkId: string;
  timestamp: string;
  model: string;
  provider: string;

  // Scores
  scores: {
    correctness: number;
    codeQuality: number;
    efficiency: number;
    bestPractices: number;
    overall: number;
  };

  // Token metrics
  tokens: {
    actual: number;
    expected: number;
    efficiency: number; // expected / actual
  };

  // Timing
  timing: {
    startTime: number;
    endTime: number;
    duration: number;
    withinLimit: boolean;
  };

  // Outputs
  output: string;
  errors: string[];
  warnings: string[];

  // Detailed check results
  checkResults: CheckResult[];
}

export interface CheckResult {
  checkName: string;
  passed: boolean;
  score: number;
  maxScore: number;
  details: string;
}

export interface BenchmarkSuiteResult {
  suiteId: string;
  timestamp: string;
  model: string;
  provider: string;

  // Aggregated scores
  overallScore: number;
  categoryScores: Record<BenchmarkCategory, number>;
  difficultyScores: Record<Difficulty, number>;

  // Token efficiency
  totalTokensUsed: number;
  totalTokensExpected: number;
  overallTokenEfficiency: number;

  // Individual results
  results: BenchmarkResult[];

  // Summary stats
  stats: {
    total: number;
    passed: number;
    failed: number;
    avgScore: number;
    avgTokenEfficiency: number;
  };
}

export interface FixtureFile {
  path: string;
  content: string;
  language: string;
}

export interface BenchmarkContext {
  workDir: string;
  fixtures: FixtureFile[];
  startTime: number;
}

// Execution types
export interface ExecutionResult {
  success: boolean;
  output: string;
  stderr: string;
  exitCode: number;
  duration: number;
}

export interface GradeResult {
  totalScore: number;
  maxScore: number;
  percentage: number;
  breakdown: {
    category: string;
    score: number;
    maxScore: number;
    checks: CheckResult[];
  }[];
}
