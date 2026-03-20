/**
 * Hypothesis Loop — codex-autoresearch pattern
 *
 * Each code change is an atomic hypothesis:
 * 1. Stash current state
 * 2. Apply change (write/edit files)
 * 3. Commit to temp branch
 * 4. Verify (run tests, lint, typecheck)
 * 5. Pass? Keep commit. Fail? Revert and refine.
 *
 * Escalation: REFINE (3x) -> PIVOT (2x) -> WEB_SEARCH (1x) -> GIVE_UP
 */

import { execSync } from "child_process";
import {
  existsSync,
  readFileSync,
  appendFileSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HypothesisResult {
  id: string;
  hypothesis: string;
  filesChanged: string[];
  verificationPassed: boolean;
  verificationOutput: string;
  attempt: number;
  strategy: "initial" | "refine" | "pivot" | "web_search";
  commitHash?: string;
  revertedAt?: string;
  durationMs: number;
}

export interface Lesson {
  hypothesis: string;
  outcome: "success" | "failure";
  error?: string;
  lesson: string;
  timestamp: number;
  files: string[];
}

export interface HypothesisStats {
  total: number;
  successes: number;
  failures: number;
  topPatterns: string[];
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class HypothesisEngine {
  private cwd: string;
  private lessonsPath: string;
  private maxRefine = 3;
  private maxPivot = 2;
  private maxWebSearch = 1;

  constructor(cwd?: string) {
    this.cwd = cwd || process.cwd();
    this.lessonsPath = join(os.homedir(), ".8gent", "lessons.jsonl");
    mkdirSync(join(os.homedir(), ".8gent"), { recursive: true });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Run a full hypothesis cycle: apply changes, verify, keep or revert.
   *
   * @param description  Human-readable description of the hypothesis.
   * @param applyChanges Async function that mutates the working tree and returns
   *                     the list of file paths that were changed.
   * @param verify       Async function that checks whether the change is valid
   *                     (tests, typecheck, lint, build, etc.).
   * @param onRefine     Optional callback invoked when the hypothesis fails and
   *                     we want to refine (receives error string + attempt #).
   * @param onPivot      Optional callback invoked when refine attempts are
   *                     exhausted and we want to try a fundamentally different
   *                     approach.
   */
  async executeHypothesis(
    description: string,
    applyChanges: () => Promise<string[]>,
    verify: () => Promise<{ passed: boolean; output: string }>,
    onRefine?: (error: string, attempt: number) => Promise<void>,
    onPivot?: (error: string) => Promise<void>,
  ): Promise<HypothesisResult> {
    const id = `hyp-${Date.now()}`;
    const start = Date.now();

    // Save current state
    const originalBranch = this.getCurrentBranch();
    const tempBranch = `hypothesis/${id}`;

    let attempt = 0;
    let lastError = "";

    // ----- INITIAL attempt -----
    const result = await this.tryHypothesis(
      id,
      description,
      tempBranch,
      applyChanges,
      verify,
    );
    if (result.verificationPassed) {
      this.recordLesson({
        hypothesis: description,
        outcome: "success",
        lesson: "Worked on first attempt",
        timestamp: Date.now(),
        files: result.filesChanged,
      });
      return {
        ...result,
        strategy: "initial",
        durationMs: Date.now() - start,
      };
    }
    lastError = result.verificationOutput;
    attempt++;

    // ----- REFINE attempts (retry with error context) -----
    for (let i = 0; i < this.maxRefine && onRefine; i++) {
      this.revertToClean(tempBranch, originalBranch);
      await onRefine(lastError, i + 1);

      const refined = await this.tryHypothesis(
        id,
        description,
        tempBranch,
        applyChanges,
        verify,
      );
      attempt++;

      if (refined.verificationPassed) {
        this.recordLesson({
          hypothesis: description,
          outcome: "success",
          lesson: `Succeeded after ${attempt} refine attempts. Error was: ${lastError.slice(0, 200)}`,
          timestamp: Date.now(),
          files: refined.filesChanged,
        });
        return {
          ...refined,
          strategy: "refine",
          attempt,
          durationMs: Date.now() - start,
        };
      }
      lastError = refined.verificationOutput;
    }

    // ----- PIVOT attempts (try different approach) -----
    for (let i = 0; i < this.maxPivot && onPivot; i++) {
      this.revertToClean(tempBranch, originalBranch);
      await onPivot(lastError);

      const pivoted = await this.tryHypothesis(
        id,
        description,
        tempBranch,
        applyChanges,
        verify,
      );
      attempt++;

      if (pivoted.verificationPassed) {
        this.recordLesson({
          hypothesis: description,
          outcome: "success",
          lesson: `Succeeded after PIVOT. Original approach failed with: ${lastError.slice(0, 200)}`,
          timestamp: Date.now(),
          files: pivoted.filesChanged,
        });
        return {
          ...pivoted,
          strategy: "pivot",
          attempt,
          durationMs: Date.now() - start,
        };
      }
      lastError = pivoted.verificationOutput;
    }

    // ----- GIVE UP — revert and record lesson -----
    this.revertToClean(tempBranch, originalBranch);
    this.recordLesson({
      hypothesis: description,
      outcome: "failure",
      error: lastError.slice(0, 500),
      lesson: `Failed after ${attempt} attempts across refine+pivot strategies`,
      timestamp: Date.now(),
      files: [],
    });

    return {
      id,
      hypothesis: description,
      filesChanged: [],
      verificationPassed: false,
      verificationOutput: lastError,
      attempt,
      strategy: "pivot",
      durationMs: Date.now() - start,
    };
  }

  /**
   * Retrieve lessons that are relevant to a given task description using
   * simple keyword matching.
   */
  getRelevantLessons(taskDescription: string, topN = 5): Lesson[] {
    if (!existsSync(this.lessonsPath)) return [];

    const lines = readFileSync(this.lessonsPath, "utf-8")
      .split("\n")
      .filter(Boolean);

    const lessons = lines
      .map((l) => {
        try {
          return JSON.parse(l) as Lesson;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Lesson[];

    const words = taskDescription.toLowerCase().split(/\s+/);

    return lessons
      .map((lesson) => ({
        lesson,
        score: words.filter(
          (w) =>
            lesson.hypothesis.toLowerCase().includes(w) ||
            lesson.lesson.toLowerCase().includes(w),
        ).length,
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
      .map((x) => x.lesson);
  }

  /**
   * Format lessons as a markdown section suitable for prompt injection.
   */
  getLessonsContext(taskDescription: string): string {
    const lessons = this.getRelevantLessons(taskDescription);
    if (lessons.length === 0) return "";

    return (
      "\n## Lessons from Previous Attempts\n" +
      lessons
        .map(
          (l, i) =>
            `${i + 1}. ${l.outcome === "success" ? "PASS" : "FAIL"} ${l.lesson}`,
        )
        .join("\n")
    );
  }

  /**
   * Get aggregate stats on accumulated lessons.
   */
  getStats(): HypothesisStats {
    if (!existsSync(this.lessonsPath)) {
      return { total: 0, successes: 0, failures: 0, topPatterns: [] };
    }

    const lines = readFileSync(this.lessonsPath, "utf-8")
      .split("\n")
      .filter(Boolean);

    const lessons = lines
      .map((l) => {
        try {
          return JSON.parse(l) as Lesson;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Lesson[];

    return {
      total: lessons.length,
      successes: lessons.filter((l) => l.outcome === "success").length,
      failures: lessons.filter((l) => l.outcome === "failure").length,
      topPatterns: lessons
        .filter((l) => l.outcome === "failure")
        .map((l) => l.error || "")
        .filter(Boolean)
        .slice(-5),
    };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private async tryHypothesis(
    id: string,
    description: string,
    tempBranch: string,
    applyChanges: () => Promise<string[]>,
    verify: () => Promise<{ passed: boolean; output: string }>,
  ): Promise<HypothesisResult> {
    // Create / reset temp branch
    try {
      this.git(`checkout -B ${tempBranch}`);
    } catch {
      /* branch may already exist */
    }

    // Apply changes
    const filesChanged = await applyChanges();

    // Commit atomically
    let commitHash: string | undefined;
    try {
      for (const f of filesChanged) {
        this.git(`add "${f}"`);
      }
      this.git(
        `commit -m "hypothesis: ${description.slice(0, 50).replace(/"/g, "'")}"`,
      );
      commitHash = this.git("rev-parse --short HEAD").trim();
    } catch {
      /* no changes to commit */
    }

    // Verify
    const { passed, output } = await verify();

    return {
      id,
      hypothesis: description,
      filesChanged,
      verificationPassed: passed,
      verificationOutput: output,
      attempt: 0,
      strategy: "initial",
      commitHash,
      durationMs: 0,
    };
  }

  private revertToClean(tempBranch: string, originalBranch: string): void {
    try {
      this.git("checkout -- .");
      this.git(`checkout ${originalBranch}`);
      this.git(`branch -D ${tempBranch}`);
    } catch {
      /* best effort */
    }
  }

  private recordLesson(lesson: Lesson): void {
    appendFileSync(this.lessonsPath, JSON.stringify(lesson) + "\n");
  }

  private getCurrentBranch(): string {
    return this.git("rev-parse --abbrev-ref HEAD").trim();
  }

  private git(cmd: string): string {
    return execSync(`git ${cmd}`, {
      cwd: this.cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
}
