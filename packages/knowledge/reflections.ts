/**
 * Reflection System — Post-task introspection
 *
 * After completing tasks, writes structured reflection files capturing
 * what worked, what didn't, lessons learned, and what would be done
 * differently. Over time, builds a corpus of lessons the agent can
 * reference to improve.
 *
 * Storage: ~/.8gent/reflections/YYYY-MM-DD-{task-slug}.md
 */

import { mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ──────────────────────────────────────────────────────────────────

export interface TaskContext {
  description: string;
  filesModified: string[];
  approach: string;
  outcome: string;
  score: number;
}

export interface TaskOutcome {
  whatWorked: string[];
  whatDidntWork: string[];
  lessonsLearned: string[];
  wouldDoDifferently: string[];
}

export interface Reflection {
  taskName: string;
  date: string;
  score: number;
  whatWorked: string[];
  whatDidntWork: string[];
  lessonsLearned: string[];
  wouldDoDifferently: string[];
  filePath: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const REFLECTIONS_DIR = join(homedir(), ".8gent", "reflections");

// ── Helpers ────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function formatDate(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function bulletList(items: string[]): string {
  if (items.length === 0) return "- (none)\n";
  return items.map((item) => `- ${item}`).join("\n") + "\n";
}

// ── ReflectionWriter ───────────────────────────────────────────────────────

export class ReflectionWriter {
  private reflectionsDir: string;

  constructor(reflectionsDir: string = REFLECTIONS_DIR) {
    this.reflectionsDir = reflectionsDir;
    mkdirSync(this.reflectionsDir, { recursive: true });
  }

  /** Write a structured reflection file after task completion. */
  writeReflection(task: TaskContext, outcome: TaskOutcome): void {
    const date = formatDate();
    const slug = slugify(task.description);
    const filename = `${date}-${slug}.md`;
    const filepath = join(this.reflectionsDir, filename);

    const content = [
      `# Reflection: ${task.description}`,
      `Date: ${new Date().toISOString()}`,
      `Score: ${task.score}/100`,
      "",
      "## What Worked",
      bulletList(outcome.whatWorked),
      "## What Didn't Work",
      bulletList(outcome.whatDidntWork),
      "## Lessons Learned",
      bulletList(outcome.lessonsLearned),
      "## Would Do Differently",
      bulletList(outcome.wouldDoDifferently),
    ].join("\n");

    Bun.write(filepath, content);
  }

  /**
   * Get recent reflections from the last N days.
   * Default: last 30 days.
   */
  getRecentReflections(days: number = 30): Reflection[] {
    if (!existsSync(this.reflectionsDir)) return [];

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = formatDate(cutoff);

    return readdirSync(this.reflectionsDir)
      .filter((f) => f.endsWith(".md"))
      .filter((f) => {
        // Files are named YYYY-MM-DD-slug.md — extract the date prefix
        const datePrefix = f.slice(0, 10);
        return datePrefix >= cutoffStr;
      })
      .sort()
      .reverse()
      .map((f) => this.parseReflection(join(this.reflectionsDir, f)))
      .filter(Boolean) as Reflection[];
  }

  /**
   * Extract the most common lessons across all reflections.
   * Returns the top N lessons by frequency.
   */
  getTopLessons(n: number = 10): string[] {
    const reflections = this.getRecentReflections(365); // Last year
    const lessonCounts = new Map<string, number>();

    for (const r of reflections) {
      for (const lesson of r.lessonsLearned) {
        const normalized = lesson.toLowerCase().trim();
        lessonCounts.set(normalized, (lessonCounts.get(normalized) ?? 0) + 1);
      }
    }

    return Array.from(lessonCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([lesson]) => lesson);
  }

  /** Parse a reflection markdown file back into a Reflection object. */
  private parseReflection(filepath: string): Reflection | null {
    try {
      const raw = readFileSync(filepath, "utf-8");

      const taskName = raw.match(/^# Reflection: (.+)$/m)?.[1] ?? "Unknown";
      const date = raw.match(/^Date: (.+)$/m)?.[1] ?? "";
      const scoreMatch = raw.match(/^Score: (\d+)\/100$/m);
      const score = scoreMatch ? Number(scoreMatch[1]) : 0;

      return {
        taskName,
        date,
        score,
        whatWorked: extractBullets(raw, "What Worked"),
        whatDidntWork: extractBullets(raw, "What Didn't Work"),
        lessonsLearned: extractBullets(raw, "Lessons Learned"),
        wouldDoDifferently: extractBullets(raw, "Would Do Differently"),
        filePath: filepath,
      };
    } catch {
      return null;
    }
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────

function extractBullets(markdown: string, section: string): string[] {
  const escapedSection = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `## ${escapedSection}\\n([\\s\\S]*?)(?=\\n## |$)`,
    "m",
  );
  const match = markdown.match(regex);
  if (!match) return [];

  return match[1]
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line !== "(none)");
}
