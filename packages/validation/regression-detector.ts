/**
 * Regression Detector - compares benchmark results across commits
 * to detect significant performance degradations (>10% drop).
 *
 * Reads the autoresearch loop-state JSON format and flags regressions
 * per-task and aggregate. Outputs a structured report.
 */

import { readFileSync, existsSync } from "fs";

// -- Types --

export interface BenchmarkIteration {
  iteration: number;
  avgScore: number;
  passing: number;
  total: number;
  scores: Record<string, number>;
  tokens?: Record<string, number>;
  durations?: Record<string, number>;
  totalTokens?: number;
  totalDurationMs?: number;
  timestamp?: string;
}

export interface BenchmarkState {
  iteration: number;
  history: BenchmarkIteration[];
  mutations?: string[];
}

export interface Regression {
  taskId: string;
  baselineScore: number;
  currentScore: number;
  delta: number;
  percentChange: number;
}

export interface RegressionReport {
  baselineFile: string;
  currentFile: string;
  baselineIteration: number;
  currentIteration: number;
  timestamp: string;
  threshold: number;
  regressions: Regression[];
  improvements: Regression[];
  stable: string[];
  aggregateBaseline: number;
  aggregateCurrent: number;
  aggregateDelta: number;
  aggregateRegressed: boolean;
  summary: string;
}

// -- Core --

const DEFAULT_THRESHOLD = 10; // percent

function loadBenchmarkState(filePath: string): BenchmarkState {
  if (!existsSync(filePath)) {
    throw new Error(`Benchmark file not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw);

  // Support both loop-state (has .history) and report (has .history) formats
  if (!data.history || !Array.isArray(data.history) || data.history.length === 0) {
    throw new Error(`No benchmark history found in: ${filePath}`);
  }
  return data as BenchmarkState;
}

function latestIteration(state: BenchmarkState): BenchmarkIteration {
  return state.history[state.history.length - 1];
}

function compareScores(
  baseline: Record<string, number>,
  current: Record<string, number>,
  threshold: number
): { regressions: Regression[]; improvements: Regression[]; stable: string[] } {
  const regressions: Regression[] = [];
  const improvements: Regression[] = [];
  const stable: string[] = [];

  const allTasks = new Set([...Object.keys(baseline), ...Object.keys(current)]);

  for (const taskId of allTasks) {
    const baseScore = baseline[taskId];
    const curScore = current[taskId];

    if (baseScore == null || curScore == null) continue;
    if (baseScore === 0 && curScore === 0) {
      stable.push(taskId);
      continue;
    }

    const delta = curScore - baseScore;
    const percentChange = baseScore === 0 ? (curScore > 0 ? 100 : 0) : (delta / baseScore) * 100;

    const entry: Regression = { taskId, baselineScore: baseScore, currentScore: curScore, delta, percentChange };

    if (percentChange <= -threshold) {
      regressions.push(entry);
    } else if (percentChange >= threshold) {
      improvements.push(entry);
    } else {
      stable.push(taskId);
    }
  }

  regressions.sort((a, b) => a.percentChange - b.percentChange);
  improvements.sort((a, b) => b.percentChange - a.percentChange);

  return { regressions, improvements, stable };
}

export function detectRegressions(
  baselinePath: string,
  currentPath: string,
  threshold = DEFAULT_THRESHOLD
): RegressionReport {
  const baselineState = loadBenchmarkState(baselinePath);
  const currentState = loadBenchmarkState(currentPath);

  const baseIter = latestIteration(baselineState);
  const curIter = latestIteration(currentState);

  const { regressions, improvements, stable } = compareScores(baseIter.scores, curIter.scores, threshold);

  const aggDelta = curIter.avgScore - baseIter.avgScore;
  const aggPct = baseIter.avgScore === 0 ? 0 : (aggDelta / baseIter.avgScore) * 100;
  const aggRegressed = aggPct <= -threshold;

  const lines: string[] = [];
  if (regressions.length === 0 && !aggRegressed) {
    lines.push("No regressions detected.");
  } else {
    if (aggRegressed) {
      lines.push(`Aggregate score dropped ${Math.abs(aggPct).toFixed(1)}% (${baseIter.avgScore} -> ${curIter.avgScore}).`);
    }
    for (const r of regressions) {
      lines.push(`${r.taskId}: ${r.baselineScore} -> ${r.currentScore} (${r.percentChange.toFixed(1)}%)`);
    }
  }
  if (improvements.length > 0) {
    lines.push(`${improvements.length} task(s) improved.`);
  }

  return {
    baselineFile: baselinePath,
    currentFile: currentPath,
    baselineIteration: baseIter.iteration,
    currentIteration: curIter.iteration,
    timestamp: new Date().toISOString(),
    threshold,
    regressions,
    improvements,
    stable,
    aggregateBaseline: baseIter.avgScore,
    aggregateCurrent: curIter.avgScore,
    aggregateDelta: aggDelta,
    aggregateRegressed: aggRegressed,
    summary: lines.join(" "),
  };
}

export function formatReport(report: RegressionReport): string {
  const out: string[] = [];
  out.push("=== Regression Detection Report ===");
  out.push(`Baseline: ${report.baselineFile} (iteration ${report.baselineIteration})`);
  out.push(`Current:  ${report.currentFile} (iteration ${report.currentIteration})`);
  out.push(`Threshold: ${report.threshold}%`);
  out.push(`Aggregate: ${report.aggregateBaseline} -> ${report.aggregateCurrent} (${report.aggregateDelta >= 0 ? "+" : ""}${report.aggregateDelta})`);
  out.push("");

  if (report.regressions.length > 0) {
    out.push(`REGRESSIONS (${report.regressions.length}):`);
    for (const r of report.regressions) {
      out.push(`  ${r.taskId}: ${r.baselineScore} -> ${r.currentScore} (${r.percentChange.toFixed(1)}%)`);
    }
    out.push("");
  }

  if (report.improvements.length > 0) {
    out.push(`IMPROVEMENTS (${report.improvements.length}):`);
    for (const i of report.improvements) {
      out.push(`  ${i.taskId}: ${i.baselineScore} -> ${i.currentScore} (+${i.percentChange.toFixed(1)}%)`);
    }
    out.push("");
  }

  if (report.stable.length > 0) {
    out.push(`STABLE (${report.stable.length}): ${report.stable.join(", ")}`);
    out.push("");
  }

  out.push(report.summary);
  return out.join("\n");
}

// -- CLI entrypoint --
if (import.meta.main) {
  const [baselinePath, currentPath, thresholdArg] = process.argv.slice(2);
  if (!baselinePath || !currentPath) {
    console.error("Usage: bun run regression-detector.ts <baseline.json> <current.json> [threshold%]");
    process.exit(1);
  }
  const threshold = thresholdArg ? parseFloat(thresholdArg) : DEFAULT_THRESHOLD;
  const report = detectRegressions(baselinePath, currentPath, threshold);
  console.log(formatReport(report));
  if (report.regressions.length > 0 || report.aggregateRegressed) {
    process.exit(1);
  }
}
