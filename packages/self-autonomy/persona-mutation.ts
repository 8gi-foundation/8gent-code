/**
 * 8gent Code - Persona Mutation
 *
 * Auto-tune SOUL.md calibration parameters based on user feedback.
 * Inspired by OpenClaw's soul document pattern (Karpathy).
 *
 * Safety: applyMutations() NEVER writes to SOUL.md directly.
 * It returns the new content string. The caller decides whether to write.
 */

import { readFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

// ============================================
// Types
// ============================================

export interface PersonaParameter {
  name: string;
  /** 0-100 scale */
  value: number;
  /** Change from baseline (can be negative) */
  delta: number;
  /** What caused the change */
  evidence: string[];
}

interface FeedbackEntry {
  parameter: string;
  direction: "up" | "down";
  reason: string;
  timestamp: number;
}

interface MutationHistoryEntry {
  parameter: string;
  oldValue: number;
  newValue: number;
  reason: string;
  timestamp: number;
}

// ============================================
// Persona Mutator
// ============================================

const FEEDBACK_DIR = join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".8gent",
);
const FEEDBACK_PATH = join(FEEDBACK_DIR, "persona-feedback.jsonl");

export class PersonaMutator {
  private soulPath: string;
  private soulContent: string;
  private baseline: PersonaParameter[];
  private feedback: FeedbackEntry[] = [];
  private history: MutationHistoryEntry[] = [];

  constructor(soulPath: string) {
    this.soulPath = soulPath;
    this.soulContent = readFileSync(soulPath, "utf-8");
    this.baseline = this.parseCalibration();
    this.loadFeedback();
  }

  /**
   * Extract current calibration values from SOUL.md's Calibration table.
   * Expects rows like: `| Directness | 90% | Says it straight. |`
   */
  parseCalibration(): PersonaParameter[] {
    const params: PersonaParameter[] = [];
    const lines = this.soulContent.split("\n");

    let inCalibrationTable = false;
    let headerPassed = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Detect the calibration section header
      if (/^###?\s*Calibration/i.test(trimmed)) {
        inCalibrationTable = true;
        headerPassed = false;
        continue;
      }

      // Stop at next heading
      if (inCalibrationTable && /^##/.test(trimmed) && !/Calibration/i.test(trimmed)) {
        break;
      }

      if (!inCalibrationTable) continue;

      // Skip the table header row and separator
      if (trimmed.startsWith("| Trait") || trimmed.startsWith("|---") || trimmed.startsWith("| ---")) {
        headerPassed = true;
        continue;
      }

      if (!headerPassed) continue;

      // Parse table row: | Name | Value% | Description |
      const match = trimmed.match(
        /^\|\s*([^|]+?)\s*\|\s*(\d+)%?\s*\|\s*([^|]+?)\s*\|$/,
      );
      if (match) {
        params.push({
          name: match[1].trim().toLowerCase(),
          value: parseInt(match[2], 10),
          delta: 0,
          evidence: [],
        });
      }
    }

    return params;
  }

  /**
   * Record user feedback on a persona trait.
   */
  recordFeedback(parameter: string, direction: "up" | "down", reason: string): void {
    const entry: FeedbackEntry = {
      parameter: parameter.toLowerCase(),
      direction,
      reason,
      timestamp: Date.now(),
    };

    this.feedback.push(entry);
    this.persistFeedback(entry);
  }

  /**
   * Based on accumulated feedback, suggest parameter mutations.
   * Each feedback nudges the parameter by 5 in the given direction.
   * Values are clamped to 0-100.
   */
  suggestMutations(): PersonaParameter[] {
    // Group feedback by parameter
    const grouped: Record<string, FeedbackEntry[]> = {};
    for (const entry of this.feedback) {
      if (!grouped[entry.parameter]) {
        grouped[entry.parameter] = [];
      }
      grouped[entry.parameter].push(entry);
    }

    const mutations: PersonaParameter[] = [];

    for (const [paramName, entries] of Object.entries(grouped)) {
      const baseline = this.baseline.find((p) => p.name === paramName);
      if (!baseline) continue;

      // Net direction: each "up" = +5, each "down" = -5
      let totalDelta = 0;
      const evidence: string[] = [];

      for (const entry of entries) {
        totalDelta += entry.direction === "up" ? 5 : -5;
        evidence.push(`[${entry.direction}] ${entry.reason}`);
      }

      const newValue = Math.max(0, Math.min(100, baseline.value + totalDelta));

      if (newValue !== baseline.value) {
        mutations.push({
          name: paramName,
          value: newValue,
          delta: newValue - baseline.value,
          evidence,
        });
      }
    }

    return mutations;
  }

  /**
   * Apply mutations to SOUL.md content.
   * Returns the new content string. NEVER writes to disk.
   */
  applyMutations(params: PersonaParameter[]): string {
    let content = this.soulContent;

    for (const param of params) {
      // Find the row in the calibration table matching this parameter name
      // Case-insensitive match on the parameter name column
      const escaped = param.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rowPattern = new RegExp(
        `(\\|\\s*${escaped}\\s*\\|\\s*)\\d+(%\\s*\\|)`,
        "i",
      );

      const match = content.match(rowPattern);
      if (match) {
        content = content.replace(rowPattern, `$1${param.value}$2`);

        // Record in history
        const baseline = this.baseline.find(
          (b) => b.name === param.name,
        );
        this.history.push({
          parameter: param.name,
          oldValue: baseline?.value ?? 0,
          newValue: param.value,
          reason: param.evidence.join("; "),
          timestamp: Date.now(),
        });
      }
    }

    return content;
  }

  /**
   * Get the full mutation history for this session.
   */
  getHistory(): MutationHistoryEntry[] {
    return [...this.history];
  }

  // ============================================
  // Private helpers
  // ============================================

  private persistFeedback(entry: FeedbackEntry): void {
    if (!existsSync(FEEDBACK_DIR)) {
      mkdirSync(FEEDBACK_DIR, { recursive: true });
    }
    appendFileSync(FEEDBACK_PATH, JSON.stringify(entry) + "\n");
  }

  private loadFeedback(): void {
    if (!existsSync(FEEDBACK_PATH)) return;

    try {
      const raw = readFileSync(FEEDBACK_PATH, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      this.feedback = lines.map((line) => JSON.parse(line) as FeedbackEntry);
    } catch {
      // Corrupted file — start fresh
      this.feedback = [];
    }
  }
}
