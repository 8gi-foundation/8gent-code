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

  const md = `---
name: ${input.pattern}
description: ${input.description}
tools: [${input.tools.join(", ")}]
learned: true
successes: 1
created: ${new Date().toISOString()}
---
# ${input.pattern}

${input.description}

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
