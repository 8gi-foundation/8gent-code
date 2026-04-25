/**
 * Skill-as-Experiment Loop (issue #1792)
 *
 * Every learned skill can ship as a scientific experiment:
 *   - hypothesis: plain-English claim (e.g. "this shortcut saves 2 retries on hydration errors")
 *   - test: a function pointer or shell command that measures impact
 *   - success metric: pass/fail callback or quantitative threshold on the measurement
 *   - auto-rollback: on failure, the skill file is deleted and the event logged
 *
 * Gated behind SKILLS_EXPERIMENTS=1. Default behaviour of `compoundSkill` is unchanged.
 *
 * Pattern source: scientific-method skill loop (abstraction brief 2026-04-24).
 * We import the concept, not the code. This file is under 200 LOC with no new deps.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { LEARNED_SKILLS_DIR } from "./compound.js";

/**
 * Execute a shell-command string and return its exit code plus stderr.
 * Surfaced as a module-level binding so tests can stub it without spawning real processes.
 * Uses `Bun.spawnSync` when available, falls back to node:child_process for portability.
 */
export let runShellTest: (cmd: string) => { exitCode: number; stderr: string } = (cmd) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bun = (globalThis as any).Bun as { spawnSync?: Function } | undefined;
  if (bun && typeof bun.spawnSync === "function") {
    const proc = bun.spawnSync(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
    const stderr =
      proc.stderr && typeof proc.stderr.toString === "function"
        ? proc.stderr.toString()
        : "";
    return { exitCode: typeof proc.exitCode === "number" ? proc.exitCode : 1, stderr };
  }
  // node fallback
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnSync } = require("child_process") as typeof import("child_process");
  const result = spawnSync("sh", ["-c", cmd], { encoding: "utf-8" });
  return { exitCode: result.status ?? 1, stderr: result.stderr ?? "" };
};

/** Test hook: replace the shell runner. */
export function setShellTestRunner(fn: typeof runShellTest): void {
  runShellTest = fn;
}

// ── Types ─────────────────────────────────────────────────────────────

/** A single measurement. A number or a boolean. Booleans coerce to 1/0. */
export type Measurement = number | boolean;

/**
 * Spec passed in with a learned skill. All fields required when running an experiment.
 */
export interface ExperimentSpec {
  /** English claim the skill is expected to support. Stored verbatim. */
  hypothesis: string;
  /**
   * Test runner. Either a string (shell command reference, not executed here,
   * recorded for operator replay) or an async callable that produces a Measurement.
   */
  test: string | (() => Promise<Measurement> | Measurement);
  /**
   * Pass/fail gate. Numeric threshold (measurement >= threshold passes) or a
   * predicate. If test is a shell command string, a predicate is required.
   */
  metric: number | ((m: Measurement) => boolean);
}

export interface ExperimentRecord {
  skillSlug: string;
  skillPath: string;
  hypothesis: string;
  test: string;
  metricDescriptor: string;
  measurement: Measurement | null;
  passed: boolean;
  rolledBack: boolean;
  error?: string;
  runAt: string;
}

export const EXPERIMENTS_DIR = join(LEARNED_SKILLS_DIR, ".experiments");

/** Optional sink (e.g. packages/memory/store.ts write). Default no-op. */
export type MemorySink = (record: ExperimentRecord) => void;
let memorySink: MemorySink = () => {};
export function setExperimentMemorySink(sink: MemorySink): void {
  memorySink = sink;
}

// ── Public API ────────────────────────────────────────────────────────

/** Feature flag check. Centralised so tests can patch env cleanly. */
export function experimentsEnabled(): boolean {
  return process.env.SKILLS_EXPERIMENTS === "1";
}

/**
 * Validate a spec before running. Returns an error message or null.
 * Shell-command tests cannot use a numeric threshold because no measurement is taken here.
 */
export function validateSpec(spec: ExperimentSpec): string | null {
  if (!spec.hypothesis || typeof spec.hypothesis !== "string") {
    return "hypothesis required (non-empty string)";
  }
  if (!spec.test) return "test required (command string or callable)";
  if (typeof spec.test === "string" && typeof spec.metric === "number") {
    return "shell-command test requires a predicate metric, not a numeric threshold";
  }
  if (typeof spec.metric !== "number" && typeof spec.metric !== "function") {
    return "metric must be a number (threshold) or a predicate function";
  }
  return null;
}

/**
 * Run an experiment against a just-written learned skill.
 * On failure, deletes the skill file (rollback) and records the event.
 * Returns the ExperimentRecord regardless of outcome.
 */
export async function runExperiment(
  skillPath: string,
  spec: ExperimentSpec,
): Promise<ExperimentRecord> {
  const err = validateSpec(spec);
  if (err) throw new Error(`invalid experiment spec: ${err}`);

  const skillSlug = skillPath.split("/").pop()?.replace(/\.md$/, "") ?? "unknown";
  const record: ExperimentRecord = {
    skillSlug,
    skillPath,
    hypothesis: spec.hypothesis,
    test: typeof spec.test === "string" ? spec.test : "[callable]",
    metricDescriptor:
      typeof spec.metric === "number" ? `>= ${spec.metric}` : "[predicate]",
    measurement: null,
    passed: false,
    rolledBack: false,
    runAt: new Date().toISOString(),
  };

  try {
    if (typeof spec.test === "function") {
      record.measurement = await spec.test();
      record.passed = evaluateMetric(record.measurement, spec.metric);
    } else {
      // Shell-command test: execute the command, exit code 0 → pass (measurement = 1),
      // nonzero → fail (measurement = 0). Exit code is the source of truth. If a
      // predicate metric is also supplied, it runs against the boolean-coerced
      // measurement and must also pass. validateSpec rejects numeric thresholds
      // against shell tests, so by here `metric` is always a predicate.
      const { exitCode, stderr } = runShellTest(spec.test);
      record.measurement = exitCode === 0 ? 1 : 0;
      const exitPassed = exitCode === 0;
      const metricPassed = evaluateMetric(record.measurement, spec.metric);
      record.passed = exitPassed && metricPassed;
      if (exitCode !== 0 && stderr) {
        record.error = stderr.slice(0, 500);
      }
    }
  } catch (e) {
    record.error = e instanceof Error ? e.message : String(e);
    record.passed = false;
  }

  if (!record.passed) {
    rollbackSkill(skillPath);
    record.rolledBack = true;
  }

  writeLedger(record);
  try {
    memorySink(record);
  } catch {
    // memory sink failure must never take down the experiment loop
  }

  return record;
}

/** Apply the metric against a measurement. */
function evaluateMetric(
  measurement: Measurement,
  metric: number | ((m: Measurement) => boolean),
): boolean {
  const value = typeof measurement === "boolean" ? (measurement ? 1 : 0) : measurement;
  if (typeof metric === "number") return value >= metric;
  return metric(measurement);
}

/** Delete the skill file. Safe on missing files. */
function rollbackSkill(skillPath: string): void {
  if (existsSync(skillPath)) unlinkSync(skillPath);
}

/** Append a JSON ledger entry per skill. */
function writeLedger(record: ExperimentRecord): void {
  mkdirSync(EXPERIMENTS_DIR, { recursive: true });
  const file = join(EXPERIMENTS_DIR, `${record.skillSlug}.json`);
  const prior: ExperimentRecord[] = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf-8")) as ExperimentRecord[])
    : [];
  prior.push(record);
  writeFileSync(file, JSON.stringify(prior, null, 2));
}

/** Query the ledger for a given skill slug (or all skills if omitted). */
export function getExperimentHistory(skillSlug?: string): ExperimentRecord[] {
  if (!existsSync(EXPERIMENTS_DIR)) return [];
  const files = skillSlug
    ? [`${skillSlug}.json`].filter((f) => existsSync(join(EXPERIMENTS_DIR, f)))
    : readdirSync(EXPERIMENTS_DIR).filter((f) => f.endsWith(".json"));
  const out: ExperimentRecord[] = [];
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(EXPERIMENTS_DIR, f), "utf-8"));
      if (Array.isArray(data)) out.push(...data);
    } catch {
      // skip malformed ledger files
    }
  }
  return out.sort((a, b) => a.runAt.localeCompare(b.runAt));
}
