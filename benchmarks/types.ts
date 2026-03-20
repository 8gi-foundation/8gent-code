// ── Benchmark v2 Types ──────────────────────────────────────────────

export interface BenchmarkDefinition {
  id: string;
  category: BenchmarkCategory;
  title: string;
  difficulty: "easy" | "medium" | "hard";
  /** The task prompt sent to the LLM */
  prompt: string;
  /** Keywords for regex-based fallback grading */
  keywords: string[];
  /** Minimum keyword matches for a passing keyword score */
  keywordThreshold: number;
  /** Enable execution-based grading via bun test */
  testExecution: boolean;
  /** Path to the bun:test harness (relative to benchmarks/) */
  testFile?: string;
  /** Maximum time in ms for execution grading */
  timeoutMs?: number;
  /** Multi-file benchmark: LLM must output multiple files with path markers */
  multiFile?: boolean;
  /** Fixture files to copy into the work directory before running tests */
  fixtures?: string[];
}

export type BenchmarkCategory =
  | "bug-fixing"
  | "file-manipulation"
  | "feature-implementation"
  | "fullstack"
  | "agentic"
  | "ui-design"
  | "battle-test"
  | "long-horizon";

export interface ExecutionGradeResult {
  /** 0-100 score from test execution */
  score: number;
  /** Total tests in harness */
  totalTests: number;
  /** Tests that passed */
  passedTests: number;
  /** Tests that failed */
  failedTests: number;
  /** Raw stdout from bun test */
  stdout: string;
  /** Raw stderr from bun test */
  stderr: string;
  /** Whether execution timed out */
  timedOut: boolean;
  /** Elapsed ms */
  durationMs: number;
}

export interface KeywordGradeResult {
  /** 0-100 score from keyword matching */
  score: number;
  /** Keywords that matched in the output */
  matchedKeywords: string[];
  /** Keywords that didn't match */
  missedKeywords: string[];
}

export interface CombinedGradeResult {
  /** Final blended score: 0.7 * execution + 0.3 * keyword */
  score: number;
  execution: ExecutionGradeResult | null;
  keyword: KeywordGradeResult;
  /** Which grading method was primary */
  method: "execution+keyword" | "keyword-only";
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface BenchmarkRun {
  benchmarkId: string;
  model: string;
  temperature: number;
  /** Raw LLM response */
  rawOutput: string;
  /** Code extracted from the response */
  extractedCode: string | null;
  grade: CombinedGradeResult;
  timestamp: number;
  /** Total wall-clock time for API call */
  durationMs: number;
  /** Token usage from OpenRouter */
  tokenUsage?: TokenUsage;
}

export interface HarnessConfig {
  /** OpenRouter API key */
  apiKey: string;
  /** Model fallback chain */
  models: string[];
  /** Temperatures to sweep */
  temperatures: number[];
  /** Categories to run (empty = all) */
  categories: BenchmarkCategory[];
  /** Output file for results TSV */
  outputFile: string;
  /** Log file for detailed output */
  logFile: string;
  /** Whether to mutate the system prompt based on results */
  mutatePrompt: boolean;
  /** Path to system prompt file for mutation */
  systemPromptPath: string;
  /** Max concurrent benchmark runs */
  concurrency: number;
}

export interface PromptMutation {
  /** The benchmark that triggered this mutation */
  benchmarkId: string;
  /** What was added/changed */
  patch: string;
  /** Score before mutation */
  scoreBefore: number;
  /** Score after mutation (if re-evaluated) */
  scoreAfter?: number;
  timestamp: number;
}

export interface SystemPromptState {
  /** Base system prompt (immutable core) */
  base: string;
  /** Accumulated mutations from benchmark runs */
  mutations: PromptMutation[];
  /** Current assembled prompt (base + mutations) */
  assembled: string;
}
