#!/usr/bin/env bun
/**
 * SWE-bench Scorer
 * Computes pass@1, per-repo breakdown, JSON reports.
 */
import * as fs from "fs";
import * as path from "path";
import type { TaskResult } from "./runner";

export interface SWEBenchReport {
  timestamp: string;
  model: string;
  total_tasks: number;
  passed_tasks: number;
  pass_at_1: number;
  avg_duration_ms: number;
  per_repo: { repo: string; total: number; passed: number; pass_rate: number }[];
  errors: { task_id: string; error: string }[];
  results: TaskResult[];
}

export function score(results: TaskResult[], model: string): SWEBenchReport {
  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const passAt1 = total > 0 ? passed / total : 0;

  const repoMap = new Map<string, { total: number; passed: number }>();
  for (const r of results) {
    const e = repoMap.get(r.repo) || { total: 0, passed: 0 };
    e.total++;
    if (r.passed) e.passed++;
    repoMap.set(r.repo, e);
  }

  const perRepo = Array.from(repoMap.entries())
    .map(([repo, { total: t, passed: p }]) => ({ repo, total: t, passed: p, pass_rate: t > 0 ? p / t : 0 }))
    .sort((a, b) => b.pass_rate - a.pass_rate);

  const errors = results.filter(r => r.error).map(r => ({ task_id: r.task_id, error: r.error! }));
  const avgDur = total > 0 ? results.reduce((s, r) => s + r.duration_ms, 0) / total : 0;

  return {
    timestamp: new Date().toISOString(), model, total_tasks: total, passed_tasks: passed,
    pass_at_1: Math.round(passAt1 * 10000) / 10000, avg_duration_ms: Math.round(avgDur),
    per_repo: perRepo, errors, results,
  };
}

export function saveReport(report: SWEBenchReport, outputDir: string): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const name = `swebench-${report.model.replace(/[/:]/g, "_")}-${Date.now()}.json`;
  const filePath = path.join(outputDir, name);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", yellow: "\x1b[33m" };

export function printSummary(report: SWEBenchReport): void {
  const passColor = report.pass_at_1 > 0.2 ? c.green : c.red;
  console.log(`\n${c.cyan}${"=".repeat(60)}${c.reset}`);
  console.log(`${c.bold}  SWE-bench Lite Results${c.reset}`);
  console.log(`${c.cyan}${"=".repeat(60)}${c.reset}`);
  console.log(`  Model:         ${c.bold}${report.model}${c.reset}`);
  console.log(`  pass@1:        ${passColor}${(report.pass_at_1 * 100).toFixed(2)}%${c.reset} (${report.passed_tasks}/${report.total_tasks})`);
  console.log(`  Avg duration:  ${c.dim}${(report.avg_duration_ms / 1000).toFixed(1)}s per task${c.reset}\n`);

  if (report.per_repo.length > 0) {
    console.log(`  ${c.bold}Per-repo breakdown:${c.reset}`);
    for (const r of report.per_repo) {
      const rc = r.pass_rate > 0.3 ? c.green : r.pass_rate > 0 ? c.yellow : c.red;
      console.log(`    ${r.repo.padEnd(35)} ${rc}${r.passed}/${r.total}${c.reset} (${(r.pass_rate * 100).toFixed(0)}%)`);
    }
    console.log();
  }
  if (report.errors.length > 0) console.log(`  ${c.yellow}${report.errors.length} tasks had errors${c.reset}`);
  console.log(`${c.cyan}${"=".repeat(60)}${c.reset}\n`);
}
