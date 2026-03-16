/**
 * Eight Model Version Manager
 *
 * Manages versioning for the Eight model family using SemVer-for-models:
 * - Patch (1.0.1): nightly fine-tune with incremental improvement
 * - Minor (1.1.0): significant benchmark improvement validated by judge
 * - Major (2.0.0): base model or architecture change
 *
 * Uses Gemini Flash (free via OpenRouter) as the judge model to evaluate
 * whether improvements warrant a version bump.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const VERSION_FILE = path.join(os.homedir(), ".8gent", "model-version.json");
const BASELINE_FILE = path.join(os.homedir(), ".8gent", "benchmark-baseline.json");

export interface ModelVersion {
  major: number;
  minor: number;
  patch: number;
  lineage: string; // "q3" for qwen3
  params: string;  // "14b"
  createdAt: string;
  baseModel: string;
  benchmarkScore: number;
  history: VersionEntry[];
}

export interface VersionEntry {
  version: string;
  date: string;
  benchmarkScore: number;
  improvement: number; // delta from previous
  promoted: boolean;
  judgeVerdict?: string;
}

export interface BenchmarkBaseline {
  score: number;
  passingCount: number;
  totalCount: number;
  lastUpdated: string;
  perBenchmark: Record<string, number>;
}

// ============================================
// Version Management
// ============================================

export function getCurrentVersion(): ModelVersion {
  try {
    if (fs.existsSync(VERSION_FILE)) {
      return JSON.parse(fs.readFileSync(VERSION_FILE, "utf-8"));
    }
  } catch {}

  // Default: first version
  return {
    major: 1,
    minor: 0,
    patch: 0,
    lineage: "q3",
    params: "14b",
    createdAt: new Date().toISOString(),
    baseModel: "qwen3:14b",
    benchmarkScore: 0,
    history: [],
  };
}

export function getVersionString(v: ModelVersion): string {
  const patchStr = v.patch > 0 ? `.${v.patch}` : "";
  return `eight-${v.major}.${v.minor}${patchStr}-${v.lineage}:${v.params}`;
}

export function saveVersion(v: ModelVersion): void {
  const dir = path.dirname(VERSION_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(VERSION_FILE, JSON.stringify(v, null, 2));
}

// ============================================
// Baseline Management
// ============================================

export function getBaseline(): BenchmarkBaseline {
  try {
    if (fs.existsSync(BASELINE_FILE)) {
      return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf-8"));
    }
  } catch {}
  return { score: 0, passingCount: 0, totalCount: 0, lastUpdated: "", perBenchmark: {} };
}

export function saveBaseline(baseline: BenchmarkBaseline): void {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2));
}

// ============================================
// Judge Model — Gemini Flash (free)
// ============================================

export async function judgeImprovement(
  oldScore: number,
  newScore: number,
  oldDetails: Record<string, number>,
  newDetails: Record<string, number>,
  openrouterApiKey: string,
): Promise<{ verdict: "patch" | "minor" | "none"; reasoning: string }> {
  const delta = newScore - oldScore;

  // Quick heuristics before calling the judge
  if (delta <= 0) {
    return { verdict: "none", reasoning: `No improvement (delta: ${delta.toFixed(1)})` };
  }
  if (delta < 2) {
    return { verdict: "patch", reasoning: `Marginal improvement (+${delta.toFixed(1)}), patch only` };
  }

  // For significant deltas, ask the judge
  const prompt = `You are a model evaluation judge. Given these benchmark results, determine if the improvement warrants a minor version bump (significant) or just a patch (incremental).

OLD SCORES (baseline):
${Object.entries(oldDetails).map(([k, v]) => `  ${k}: ${v}`).join("\n")}
Average: ${oldScore.toFixed(1)}

NEW SCORES (candidate):
${Object.entries(newDetails).map(([k, v]) => `  ${k}: ${v}`).join("\n")}
Average: ${newScore.toFixed(1)}

Delta: +${delta.toFixed(1)} points

CRITERIA:
- PATCH: Small incremental gains, 1-5 point improvement, no new benchmarks passing
- MINOR: Significant leap, 5+ point improvement, OR new benchmarks start passing that didn't before
- NONE: No improvement or regression

Respond with exactly one word: PATCH, MINOR, or NONE. Then a brief reason.`;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openrouterApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash:free",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 100,
        temperature: 0,
      }),
    });

    if (!response.ok) {
      // Fallback to heuristic
      return {
        verdict: delta >= 5 ? "minor" : "patch",
        reasoning: `Judge unavailable. Heuristic: delta=${delta.toFixed(1)}`,
      };
    }

    const data = await response.json() as any;
    const reply = data.choices?.[0]?.message?.content?.trim() || "";
    const firstWord = reply.split(/\s/)[0].toUpperCase();

    if (firstWord === "MINOR") return { verdict: "minor", reasoning: reply };
    if (firstWord === "PATCH") return { verdict: "patch", reasoning: reply };
    return { verdict: "none", reasoning: reply };
  } catch {
    return {
      verdict: delta >= 5 ? "minor" : "patch",
      reasoning: `Judge error. Heuristic: delta=${delta.toFixed(1)}`,
    };
  }
}

// ============================================
// Version Bump Logic
// ============================================

export async function evaluateAndBump(
  newScore: number,
  newDetails: Record<string, number>,
  openrouterApiKey: string,
): Promise<{ bumped: boolean; newVersion: string; verdict: string }> {
  const current = getCurrentVersion();
  const baseline = getBaseline();

  const { verdict, reasoning } = await judgeImprovement(
    baseline.score,
    newScore,
    baseline.perBenchmark,
    newDetails,
    openrouterApiKey,
  );

  if (verdict === "none") {
    return { bumped: false, newVersion: getVersionString(current), verdict: reasoning };
  }

  // Bump version
  if (verdict === "minor") {
    current.minor++;
    current.patch = 0;
  } else {
    current.patch++;
  }

  current.benchmarkScore = newScore;

  // Record in history
  current.history.push({
    version: getVersionString(current),
    date: new Date().toISOString(),
    benchmarkScore: newScore,
    improvement: newScore - baseline.score,
    promoted: verdict === "minor",
    judgeVerdict: reasoning,
  });

  // Keep last 20 entries
  if (current.history.length > 20) {
    current.history = current.history.slice(-20);
  }

  saveVersion(current);

  // Update baseline
  saveBaseline({
    score: newScore,
    passingCount: Object.values(newDetails).filter(s => s >= 70).length,
    totalCount: Object.keys(newDetails).length,
    lastUpdated: new Date().toISOString(),
    perBenchmark: newDetails,
  });

  return { bumped: true, newVersion: getVersionString(current), verdict: reasoning };
}
