/**
 * 8gent Code Benchmark Suite
 *
 * Comprehensive coding benchmarks to test and showcase 8gent's maximum coding abilities.
 * Following Andrej Karpathy's auto-research methodology.
 */

// Types
export * from "./types";

// Grader
export { BenchmarkGrader, createStandardRubric } from "./grader";

// Category benchmarks
export { fileManipulationBenchmarks } from "./categories/file-manipulation/benchmarks";
export { multiFileBenchmarks } from "./categories/multi-file/benchmarks";
export { bugFixingBenchmarks } from "./categories/bug-fixing/benchmarks";
export { featureImplementationBenchmarks } from "./categories/feature-implementation/benchmarks";
export { codeReviewBenchmarks } from "./categories/code-review/benchmarks";
export { testGenerationBenchmarks } from "./categories/test-generation/benchmarks";
export { documentationBenchmarks } from "./categories/documentation/benchmarks";

// Combined benchmarks
import { fileManipulationBenchmarks } from "./categories/file-manipulation/benchmarks";
import { multiFileBenchmarks } from "./categories/multi-file/benchmarks";
import { bugFixingBenchmarks } from "./categories/bug-fixing/benchmarks";
import { featureImplementationBenchmarks } from "./categories/feature-implementation/benchmarks";
import { codeReviewBenchmarks } from "./categories/code-review/benchmarks";
import { testGenerationBenchmarks } from "./categories/test-generation/benchmarks";
import { documentationBenchmarks } from "./categories/documentation/benchmarks";

export const ALL_BENCHMARKS = [
  ...fileManipulationBenchmarks,
  ...multiFileBenchmarks,
  ...bugFixingBenchmarks,
  ...featureImplementationBenchmarks,
  ...codeReviewBenchmarks,
  ...testGenerationBenchmarks,
  ...documentationBenchmarks,
];

// Benchmark counts by category
export const BENCHMARK_STATS = {
  fileManipulation: fileManipulationBenchmarks.length,
  multiFile: multiFileBenchmarks.length,
  bugFixing: bugFixingBenchmarks.length,
  featureImplementation: featureImplementationBenchmarks.length,
  codeReview: codeReviewBenchmarks.length,
  testGeneration: testGenerationBenchmarks.length,
  documentation: documentationBenchmarks.length,
  total: ALL_BENCHMARKS.length,
};
