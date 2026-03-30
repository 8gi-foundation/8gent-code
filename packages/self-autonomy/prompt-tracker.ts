/**
 * Prompt Optimization Tracker
 *
 * Logs system prompts with outcomes, tracks which variations work best
 * per task category, and suggests improvements from failure patterns.
 * Data stored in ~/.8gent/prompt-history.json.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ============================================
// Types
// ============================================

export type PromptOutcome = "success" | "failure" | "partial";

export interface PromptEntry {
  id: string;
  timestamp: string;
  /** Task category - e.g. "code-gen", "refactor", "debug", "explain" */
  category: string;
  /** Hash of the system prompt text (avoids storing huge strings repeatedly) */
  promptHash: string;
  /** First 200 chars of the prompt for human readability */
  promptPreview: string;
  /** Full prompt text */
  promptText: string;
  outcome: PromptOutcome;
  /** Optional notes on what went wrong or right */
  notes: string;
  /** Duration in ms if available */
  durationMs?: number;
}

export interface PromptHistory {
  version: 1;
  entries: PromptEntry[];
}

export interface CategoryStats {
  category: string;
  total: number;
  success: number;
  failure: number;
  partial: number;
  successRate: number;
  /** The prompt hash that has the best success rate in this category */
  bestPromptHash: string | null;
  bestPromptPreview: string | null;
}

export interface FailurePattern {
  category: string;
  failureCount: number;
  commonNotes: string[];
  suggestion: string;
}

export interface EffectivenessReport {
  generatedAt: string;
  totalEntries: number;
  overallSuccessRate: number;
  categoryBreakdown: CategoryStats[];
  failurePatterns: FailurePattern[];
  topSuggestions: string[];
}

// ============================================
// Storage
// ============================================

const DATA_DIR = path.join(os.homedir(), ".8gent");
const HISTORY_FILE = path.join(DATA_DIR, "prompt-history.json");

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadHistory(): PromptHistory {
  ensureDir();
  if (!fs.existsSync(HISTORY_FILE)) {
    return { version: 1, entries: [] };
  }
  const raw = fs.readFileSync(HISTORY_FILE, "utf-8");
  return JSON.parse(raw) as PromptHistory;
}

function saveHistory(history: PromptHistory): void {
  ensureDir();
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), "utf-8");
}

// ============================================
// Hashing
// ============================================

function hashPrompt(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return "ph_" + Math.abs(h).toString(36);
}

// ============================================
// Public API
// ============================================

/** Log a prompt usage with its outcome. */
export function logPrompt(
  category: string,
  promptText: string,
  outcome: PromptOutcome,
  notes = "",
  durationMs?: number,
): PromptEntry {
  const history = loadHistory();
  const entry: PromptEntry = {
    id: `pe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    category,
    promptHash: hashPrompt(promptText),
    promptPreview: promptText.slice(0, 200),
    promptText,
    outcome,
    notes,
    durationMs,
  };
  history.entries.push(entry);
  saveHistory(history);
  return entry;
}

/** Get stats per category. */
export function getCategoryStats(): CategoryStats[] {
  const { entries } = loadHistory();
  const byCategory = new Map<string, PromptEntry[]>();
  for (const e of entries) {
    const list = byCategory.get(e.category) || [];
    list.push(e);
    byCategory.set(e.category, list);
  }

  const stats: CategoryStats[] = [];
  for (const [category, items] of byCategory) {
    const success = items.filter((e) => e.outcome === "success").length;
    const failure = items.filter((e) => e.outcome === "failure").length;
    const partial = items.filter((e) => e.outcome === "partial").length;

    // Find best prompt hash by success rate (min 2 uses)
    const byHash = new Map<string, { ok: number; total: number; preview: string }>();
    for (const e of items) {
      const rec = byHash.get(e.promptHash) || { ok: 0, total: 0, preview: e.promptPreview };
      rec.total++;
      if (e.outcome === "success") rec.ok++;
      byHash.set(e.promptHash, rec);
    }
    let bestHash: string | null = null;
    let bestPreview: string | null = null;
    let bestRate = -1;
    for (const [hash, rec] of byHash) {
      if (rec.total >= 2) {
        const rate = rec.ok / rec.total;
        if (rate > bestRate) {
          bestRate = rate;
          bestHash = hash;
          bestPreview = rec.preview;
        }
      }
    }

    stats.push({
      category,
      total: items.length,
      success,
      failure,
      partial,
      successRate: items.length > 0 ? success / items.length : 0,
      bestPromptHash: bestHash,
      bestPromptPreview: bestPreview,
    });
  }
  return stats;
}

/** Detect failure patterns and suggest improvements. */
export function getFailurePatterns(): FailurePattern[] {
  const { entries } = loadHistory();
  const failuresByCategory = new Map<string, PromptEntry[]>();
  for (const e of entries) {
    if (e.outcome === "failure") {
      const list = failuresByCategory.get(e.category) || [];
      list.push(e);
      failuresByCategory.set(e.category, list);
    }
  }

  const patterns: FailurePattern[] = [];
  for (const [category, failures] of failuresByCategory) {
    if (failures.length < 2) continue;

    const notes = failures.map((f) => f.notes).filter(Boolean);

    // Simple keyword frequency for suggestion generation
    const words = notes.join(" ").toLowerCase().split(/\s+/);
    const freq = new Map<string, number>();
    const stopWords = new Set(["the", "a", "an", "is", "was", "to", "in", "of", "and", "or", ""]);
    for (const w of words) {
      if (w.length > 3 && !stopWords.has(w)) {
        freq.set(w, (freq.get(w) || 0) + 1);
      }
    }
    const topWords = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([w]) => w);

    let suggestion = `Review prompts for "${category}" - ${failures.length} failures detected.`;
    if (topWords.length > 0) {
      suggestion += ` Common themes: ${topWords.join(", ")}. Consider adding explicit instructions around these areas.`;
    }

    patterns.push({
      category,
      failureCount: failures.length,
      commonNotes: notes.slice(0, 5),
      suggestion,
    });
  }

  return patterns.sort((a, b) => b.failureCount - a.failureCount);
}

/** Generate a full effectiveness report. */
export function generateReport(): EffectivenessReport {
  const { entries } = loadHistory();
  const categoryBreakdown = getCategoryStats();
  const failurePatterns = getFailurePatterns();

  const successCount = entries.filter((e) => e.outcome === "success").length;

  const topSuggestions: string[] = [];

  // Suggestion: categories with < 50% success rate
  for (const cat of categoryBreakdown) {
    if (cat.total >= 3 && cat.successRate < 0.5) {
      topSuggestions.push(
        `"${cat.category}" has a ${(cat.successRate * 100).toFixed(0)}% success rate across ${cat.total} runs - needs prompt rework.`,
      );
    }
  }

  // Suggestion: use best-performing prompt variants
  for (const cat of categoryBreakdown) {
    if (cat.bestPromptHash && cat.successRate < 0.8) {
      topSuggestions.push(
        `"${cat.category}" has a known best prompt variant (${cat.bestPromptHash}) - consider standardizing on it.`,
      );
    }
  }

  // Pull in failure pattern suggestions
  for (const fp of failurePatterns.slice(0, 3)) {
    topSuggestions.push(fp.suggestion);
  }

  return {
    generatedAt: new Date().toISOString(),
    totalEntries: entries.length,
    overallSuccessRate: entries.length > 0 ? successCount / entries.length : 0,
    categoryBreakdown,
    failurePatterns,
    topSuggestions,
  };
}
