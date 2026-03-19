/**
 * Auto-Skill Generation — Hermes-inspired self-evolution
 *
 * After solving a complex task (score >= 80), auto-generates a reusable
 * skill file stored as YAML in ~/.8gent/skills/. Skills capture the pattern,
 * approach, and code snippets so the agent can replay successful strategies.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ──────────────────────────────────────────────────────────────────

export interface CodeSnippet {
  language: string;
  content: string;
}

export interface Skill {
  name: string;
  /** Natural-language description of when this skill should activate */
  trigger: string;
  /** High-level approach / pattern description */
  pattern: string;
  codeSnippets: CodeSnippet[];
  createdAt: string;
  usageCount: number;
  successRate: number;
}

export interface TaskContext {
  description: string;
  filesModified: string[];
  approach: string;
  outcome: string;
  score: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const SKILLS_DIR = join(homedir(), ".8gent", "skills");
const SCORE_THRESHOLD = 80;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** Minimal YAML serializer — good enough for skill files. */
function toYaml(skill: Skill): string {
  const snippetsYaml = skill.codeSnippets
    .map(
      (s) =>
        `  - language: ${quote(s.language)}\n    content: |\n${indent(s.content, 6)}`,
    )
    .join("\n");

  return [
    `name: ${quote(skill.name)}`,
    `trigger: ${quote(skill.trigger)}`,
    `pattern: ${quote(skill.pattern)}`,
    `codeSnippets:`,
    snippetsYaml || "  []",
    `createdAt: ${quote(skill.createdAt)}`,
    `usageCount: ${skill.usageCount}`,
    `successRate: ${skill.successRate}`,
  ].join("\n");
}

/** Parse a skill YAML back to an object (simple key-value + snippet blocks). */
function fromYaml(raw: string): Skill {
  const get = (key: string): string => {
    const m = raw.match(new RegExp(`^${key}:\\s*['"]?(.*?)['"]?\\s*$`, "m"));
    return m?.[1] ?? "";
  };

  // Parse code snippets block
  const snippets: CodeSnippet[] = [];
  const snippetBlocks = raw.split(/^\s{2}- language:/m).slice(1);
  for (const block of snippetBlocks) {
    const langMatch = block.match(/^\s*['"]?(.*?)['"]?\s*$/m);
    const contentMatch = block.match(/content:\s*\|\n([\s\S]*?)(?=\n\s{2}-|\n\w|$)/);
    if (langMatch && contentMatch) {
      snippets.push({
        language: langMatch[1].trim(),
        content: contentMatch[1].replace(/^ {6}/gm, "").trimEnd(),
      });
    }
  }

  return {
    name: get("name"),
    trigger: get("trigger"),
    pattern: get("pattern"),
    codeSnippets: snippets,
    createdAt: get("createdAt"),
    usageCount: Number(get("usageCount")) || 0,
    successRate: Number(get("successRate")) || 0,
  };
}

function quote(s: string): string {
  if (/[:#{}[\],&*?|>!%@`]/.test(s) || s.includes("'") || s.includes('"')) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return `"${s}"`;
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

// ── AutoSkillGenerator ─────────────────────────────────────────────────────

export class AutoSkillGenerator {
  private skillsDir: string;

  constructor(skillsDir: string = SKILLS_DIR) {
    this.skillsDir = skillsDir;
    mkdirSync(this.skillsDir, { recursive: true });
  }

  /**
   * Generate a skill from a completed task context.
   * Returns null if the task score is below the threshold.
   */
  generateSkill(task: TaskContext): Skill | null {
    if (task.score < SCORE_THRESHOLD) {
      return null;
    }

    const name = slugify(task.description).slice(0, 48);

    return {
      name,
      trigger: task.description,
      pattern: task.approach,
      codeSnippets: task.filesModified.map((f) => ({
        language: extToLang(f),
        content: `// Modified: ${f}\n// ${task.outcome}`,
      })),
      createdAt: new Date().toISOString(),
      usageCount: 0,
      successRate: task.score / 100,
    };
  }

  /** Persist a skill to disk and return the file path. */
  saveSkill(skill: Skill): string {
    const filename = `${skill.name}.yaml`;
    const filepath = join(this.skillsDir, filename);
    writeFileSync(filepath, toYaml(skill), "utf-8");
    return filepath;
  }

  /** Load all saved skills from the skills directory. */
  loadSkills(): Skill[] {
    if (!existsSync(this.skillsDir)) return [];

    return readdirSync(this.skillsDir)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => {
        try {
          const raw = readFileSync(join(this.skillsDir, f), "utf-8");
          return fromYaml(raw);
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Skill[];
  }

  /**
   * Find skills relevant to a given task description.
   * Uses simple token-overlap scoring — good enough without embeddings.
   */
  findRelevantSkills(taskDescription: string): Skill[] {
    const skills = this.loadSkills();
    const queryTokens = tokenize(taskDescription);

    const scored = skills.map((skill) => {
      const triggerTokens = tokenize(skill.trigger);
      const patternTokens = tokenize(skill.pattern);
      const allTokens = new Set([...triggerTokens, ...patternTokens]);

      let overlap = 0;
      for (const t of queryTokens) {
        if (allTokens.has(t)) overlap++;
      }

      const score = queryTokens.length > 0 ? overlap / queryTokens.length : 0;
      return { skill, score };
    });

    return scored
      .filter((s) => s.score > 0.2)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.skill);
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function extToLang(filepath: string): string {
  const ext = filepath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
    md: "markdown",
    yaml: "yaml",
    yml: "yaml",
    json: "json",
    sh: "bash",
    css: "css",
    html: "html",
  };
  return map[ext] ?? ext;
}
