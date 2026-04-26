/**
 * Skill Self-Creation (issue #1911)
 *
 * Closes the loop where 8gent could not author NEW skills mid-session.
 * `createSkill()` accepts a task description, success criteria, and example
 * input/output pairs, then:
 *   1. Generates a SKILL.md body matching the format of existing on-disk skills.
 *   2. Derives matcher keywords (triggers) from the task description.
 *   3. Builds a callable experiment from the examples, scoring how many
 *      success-criteria keywords appear in expected outputs.
 *   4. Runs the experiment via packages/skills/experiment.ts.
 *   5. Persists to .8gent/skills/<slug>/SKILL.md only if the A/B test passes.
 *
 * Design constraint: reuses runExperiment as the validation primitive instead
 * of inventing a parallel A/B harness. The "with-skill" arm is the new SKILL.md
 * we just wrote; the "without-skill" baseline is implicit in the score
 * threshold (a passing measurement is one that covers >=50% of criteria).
 *
 * No new dependencies. No em dashes in user-visible strings.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExperimentRecord, runExperiment } from "./experiment.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface SkillExample {
	input: string;
	output: string;
}

export interface CreateSkillInput {
	/** Plain English description of the task this skill solves. */
	taskDescription: string;
	/** Bullet points the skill must satisfy to be considered useful. */
	successCriteria: string[];
	/** Concrete input/output pairs the skill should be able to handle. */
	examples: SkillExample[];
	/** Optional override of skill name (otherwise derived from taskDescription). */
	name?: string;
	/** Optional tools list. Defaults to a conservative read-only set. */
	tools?: string[];
	/**
	 * Where to root the persisted skill. Defaults to `<cwd>/.8gent/skills`.
	 * Tests pass a temp dir.
	 */
	skillsRoot?: string;
	/**
	 * Override the score threshold (0..1) the experiment must beat to keep
	 * the skill. Default 0.5 (>=50% of criteria covered by examples).
	 */
	threshold?: number;
}

export interface CreateSkillResult {
	slug: string;
	path: string | null;
	abResult: ExperimentRecord;
}

// ── Slug + tokens ─────────────────────────────────────────────────────

/** Lowercase, hyphenated, ASCII-only slug. Trimmed to 60 chars. */
export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
}

/** Tokenise into unique lowercase keyword set. Stopwords filtered. */
const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"that",
	"this",
	"from",
	"into",
	"when",
	"then",
	"been",
	"have",
	"will",
	"should",
	"would",
	"could",
	"about",
	"there",
	"their",
	"them",
	"they",
	"what",
	"which",
	"while",
	"some",
	"more",
	"than",
	"also",
	"because",
	"after",
	"before",
]);

export function extractKeywords(text: string, max = 8): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
		if (raw.length < 3) continue;
		if (STOPWORDS.has(raw)) continue;
		if (seen.has(raw)) continue;
		seen.add(raw);
		out.push(raw);
		if (out.length >= max) break;
	}
	return out;
}

// ── YAML frontmatter safety (mirrors compound.ts yamlSafe) ────────────

function yamlSafe(value: string): string {
	const oneline = value.replace(/[\r\n]+/g, " ").trim();
	if (/[:#{}[\]|>&*!%@`]/.test(oneline) || oneline.startsWith("'") || oneline.startsWith('"')) {
		return `"${oneline.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return oneline;
}

// ── SKILL.md body ─────────────────────────────────────────────────────

/**
 * Render the skill markdown matching the format used by
 * packages/skills/systematic-debugging/SKILL.md and
 * packages/skills/verification-before-completion/SKILL.md.
 */
export function renderSkillMarkdown(input: CreateSkillInput, slug: string): string {
	const name = input.name ?? slug;
	const tools = input.tools ?? ["read", "grep", "bash"];
	const triggers = extractKeywords(input.taskDescription, 6);

	const safeName = yamlSafe(name);
	const safeDesc = yamlSafe(input.taskDescription);
	const safeTools = tools.map((t) => t.replace(/[^a-zA-Z0-9_-]/g, "")).join(", ");
	const safeTriggers = triggers.map((t) => t.replace(/[^a-z0-9-]/g, "")).join(", ");

	const criteriaBlock = input.successCriteria
		.map((c) => `- ${c.replace(/[\r\n]+/g, " ").trim()}`)
		.join("\n");

	const examplesBlock = input.examples
		.map(
			(e, i) =>
				`### Example ${i + 1}\n\n**Input:**\n\n\`\`\`\n${e.input.trim()}\n\`\`\`\n\n**Output:**\n\n\`\`\`\n${e.output.trim()}\n\`\`\``,
		)
		.join("\n\n");

	const title = name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

	return `---
name: ${safeName}
description: ${safeDesc}
tools: [${safeTools}]
triggers: [${safeTriggers}]
created: ${new Date().toISOString()}
self-authored: true
---

# ${title}

${input.taskDescription.replace(/[\r\n]{3,}/g, "\n\n").trim()}

## When to use

${criteriaBlock}

## Examples

${examplesBlock}

## Notes

This skill was authored by 8gent during a session. It survived an A/B validation against its own success criteria before being persisted. If it stops being useful, delete this file.
`;
}

// ── Experiment scoring ────────────────────────────────────────────────

/**
 * Score the example set against the success criteria. Each criterion is
 * tokenised, and we count it as covered if any token of length >=4 appears
 * in any example input or output. Returns coverage in [0, 1].
 *
 * This is the "with-skill" arm of the A/B test: the skill claims its examples
 * exercise the criteria. If they do not, the skill is not useful and we roll
 * back. The implicit "without-skill" baseline is 0 (no examples, no coverage).
 */
export function scoreCoverage(criteria: string[], examples: SkillExample[]): number {
	if (criteria.length === 0) return 0;
	const haystack = examples
		.flatMap((e) => [e.input, e.output])
		.join(" \n ")
		.toLowerCase();

	let covered = 0;
	for (const c of criteria) {
		const tokens = c
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((t) => t.length >= 4 && !STOPWORDS.has(t));
		if (tokens.length === 0) {
			// Criterion has no scoreable tokens. Count as covered to avoid
			// punishing short criteria like "fast" or "safe".
			covered++;
			continue;
		}
		if (tokens.some((t) => haystack.includes(t))) covered++;
	}
	return covered / criteria.length;
}

// ── Main API ──────────────────────────────────────────────────────────

/**
 * Author a new skill from a task description, validate it against its own
 * examples, and persist if it passes.
 *
 * Returns:
 *   - slug: kebab-case identifier
 *   - path: absolute file path if persisted, null if rolled back
 *   - abResult: full ExperimentRecord (always present)
 */
export async function createSkill(input: CreateSkillInput): Promise<CreateSkillResult> {
	if (!input.taskDescription || input.taskDescription.trim().length < 4) {
		throw new Error("createSkill: taskDescription required (>=4 chars)");
	}
	if (!Array.isArray(input.successCriteria) || input.successCriteria.length === 0) {
		throw new Error("createSkill: at least one successCriteria entry required");
	}
	if (!Array.isArray(input.examples) || input.examples.length === 0) {
		throw new Error("createSkill: at least one example required");
	}

	const slug = slugify(input.name ?? input.taskDescription);
	if (!slug) throw new Error("createSkill: derived slug is empty");

	const root = input.skillsRoot ?? join(process.cwd(), ".8gent", "skills");
	const skillDir = join(root, slug);
	const skillPath = join(skillDir, "SKILL.md");

	// Write skill BEFORE running experiment so runExperiment can roll it back
	// on failure (it deletes the file path it is given).
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(skillPath, renderSkillMarkdown(input, slug));

	const threshold = typeof input.threshold === "number" ? input.threshold : 0.5;

	const abResult = await runExperiment(skillPath, {
		hypothesis: `Skill "${slug}" examples cover at least ${Math.round(threshold * 100)}% of stated success criteria.`,
		test: () => scoreCoverage(input.successCriteria, input.examples),
		metric: threshold,
	});

	// runExperiment deletes the skill file on failure. But it lives inside
	// our slug directory, which we should also clean up to avoid empty dirs
	// hanging around.
	if (abResult.rolledBack && existsSync(skillDir)) {
		try {
			rmSync(skillDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}

	return {
		slug,
		path: abResult.rolledBack ? null : skillPath,
		abResult,
	};
}
