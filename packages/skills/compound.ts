/**
 * Skill Compounding — extract completed tasks as reusable markdown skills.
 *
 * When a task completes successfully, call `compoundSkill()` to persist the
 * pattern as a `.md` file in ~/.8gent/learned-skills/. These are loaded by
 * the SkillManager on next session, making the agent smarter with use.
 *
 * This is the "guild mechanic" — every success teaches the agent.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
	/**
	 * Optional experiment spec (issue #1792). When SKILLS_EXPERIMENTS=1 and this
	 * field is set, `compoundSkill` runs the experiment after writing the skill,
	 * auto-rolls back on failure, and records the outcome to the experiment ledger.
	 * See packages/skills/experiment.ts.
	 */
	experiment?: import("./experiment.js").ExperimentSpec;
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

	const stepsBlock = input.steps.map((s, i) => `${i + 1}. ${s}`).join("\n");

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
		(_, n) => `successes: ${Number.parseInt(n, 10) + 1}`,
	);
	if (updated !== content) {
		writeFileSync(filePath, updated);
	}
}

/** List all learned skill file paths. */
export function listLearnedSkills(): string[] {
	if (!existsSync(LEARNED_SKILLS_DIR)) return [];
	return readdirSync(LEARNED_SKILLS_DIR)
		.filter((f) => f.endsWith(".md") && !f.startsWith("."))
		.map((f) => join(LEARNED_SKILLS_DIR, f));
}

/**
 * Experiment-aware variant of `compoundSkill` (issue #1792).
 *
 * - If `input.experiment` is absent, behaves exactly like `compoundSkill`.
 * - If the env flag `SKILLS_EXPERIMENTS=1` is not set, behaves exactly like
 *   `compoundSkill` (the experiment is ignored, preserving existing defaults).
 * - Otherwise writes the skill, runs the experiment, and rolls back on failure.
 *
 * Returns `{ path, record }`:
 *   - `path` is the learned-skill file path when kept, or `null` on rollback or dedup.
 *   - `record` is the ExperimentRecord when an experiment ran, or `null` otherwise.
 */
export async function compoundSkillWithExperiment(input: CompoundInput): Promise<{
	path: string | null;
	record: import("./experiment.js").ExperimentRecord | null;
}> {
	const path = compoundSkill(input);
	const { experimentsEnabled, runExperiment } = await import("./experiment.js");

	if (!path || !input.experiment || !experimentsEnabled()) {
		return { path, record: null };
	}

	const record = await runExperiment(path, input.experiment);
	return { path: record.rolledBack ? null : path, record };
}
