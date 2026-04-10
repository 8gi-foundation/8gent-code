/**
 * Skill Compounding — extract completed tasks as reusable markdown skills.
 *
 * When a task completes successfully, call `compoundSkill()` to persist the
 * pattern as a `.md` file in ~/.8gent/learned-skills/. These are loaded by
 * the SkillManager on next session, making the agent smarter with use.
 *
 * This is the "guild mechanic" — every success teaches the agent.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const LEARNED_SKILLS_DIR = join(homedir(), ".8gent", "learned-skills");

// SEC-K5: Sanitize strings for safe YAML frontmatter embedding
function yamlSafe(value: string): string {
  // Strip newlines (prevents field injection), then quote if it contains YAML special chars
  const oneline = value.replace(/[\r\n]+/g, " ").trim();
  if (/[:#{}[\]|>&*!%@`]/.test(oneline) || oneline.startsWith("'") || oneline.startsWith('"')) {
    return `"${oneline.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return oneline;
}

export interface CompoundInput {
  /** Short pattern name, e.g. "deploy-nextjs" or "fix-hydration-error" */
  pattern: string;
  /** Plain-English description of what was accomplished */
  description: string;
  /** Ordered steps the agent took */
  steps: string[];
  /** Tool names used during the task */
  tools: string[];
  /** Freeform context: repo name, file paths, technology stack */
  context?: string;
}

/**
 * Persist a completed task as a learned skill markdown file.
 * Returns the file path written, or null if a skill with that pattern already exists
 * (bumps its confidence comment instead).
 */
export function compoundSkill(input: CompoundInput): string | null {
  mkdirSync(LEARNED_SKILLS_DIR, { recursive: true });

  const slug = input.pattern
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const filePath = join(LEARNED_SKILLS_DIR, `${slug}.md`);

  // If skill already exists, bump the success count in the frontmatter
  if (existsSync(filePath)) {
    bumpConfidence(filePath);
    return null;
  }

  const stepsBlock = input.steps
    .map((s, i) => `${i + 1}. ${s}`)
    .join("\n");

  // SEC-K5: Sanitize all frontmatter values to prevent YAML field injection
  const safeName = yamlSafe(input.pattern);
  const safeDesc = yamlSafe(input.description);
  const safeTools = input.tools.map((t) => t.replace(/[^a-zA-Z0-9_-]/g, "")).join(", ");

  const md = `---
name: ${safeName}
description: ${safeDesc}
tools: [${safeTools}]
learned: true
successes: 1
created: ${new Date().toISOString()}
---
# ${input.pattern.replace(/[\r\n]+/g, " ").trim()}

${input.description.replace(/[\r\n]{3,}/g, "\n\n").trim()}

## Steps

${stepsBlock}
${input.context ? `\n## Context\n\n${input.context}\n` : ""}`;

  writeFileSync(filePath, md);
  return filePath;
}

/** Increment the successes counter in frontmatter. */
function bumpConfidence(filePath: string): void {
  const content = readFileSync(filePath, "utf-8");
  const updated = content.replace(
    /^successes:\s*(\d+)/m,
    (_, n) => `successes: ${parseInt(n, 10) + 1}`,
  );
  if (updated !== content) {
    writeFileSync(filePath, updated);
  }
}

/** List all learned skill file paths. */
export function listLearnedSkills(): string[] {
  if (!existsSync(LEARNED_SKILLS_DIR)) return [];
  return readdirSync(LEARNED_SKILLS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(LEARNED_SKILLS_DIR, f));
}
