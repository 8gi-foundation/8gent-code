/**
 * Skill self-creation (issue #1904).
 *
 * v1 is deliberately consent-first:
 *   1. Draft one focused skill from structured inputs.
 *   2. Validate the draft with deterministic local checks.
 *   3. Persist only when the caller passes approved: true.
 *   4. Write a flat ~/.8gent/skills/<slug>.md file, matching SkillManager's
 *      user-skill loader.
 *
 * This is not an autonomous mutation engine and does not run generated shell
 * experiments. Callers should reload SkillManager after persistence so aliases
 * and slash triggers are registered through the normal path.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
	/** Optional override of skill name. Otherwise derived from taskDescription. */
	name?: string;
	/** Primary slash command. Defaults to /<slug>. */
	trigger?: string;
	/** Optional extra slash commands. */
	aliases?: string[];
	/** Optional tool allowlist. Defaults to read-only tools. */
	tools?: string[];
	/** Where to write user skills. Defaults to ~/.8gent/skills. */
	skillsRoot?: string;
	/** Required for durable persistence. Omit for draft/preview only. */
	approved?: boolean;
	/** Existing files are rejected unless this is true. */
	allowOverwrite?: boolean;
}

export interface SkillCreationValidation {
	passed: boolean;
	errors: string[];
	warnings: string[];
}

export interface SkillDraft {
	slug: string;
	fileName: string;
	filePath: string;
	markdown: string;
	validation: SkillCreationValidation;
}

export interface CreateSkillResult extends SkillDraft {
	/** Absolute file path when persisted, otherwise null. */
	path: string | null;
	/** True when the caller should reload SkillManager. */
	requiresReload: boolean;
}

const DEFAULT_TOOLS = ["read", "grep"];

const ALLOWED_TOOLS = new Set([
	"read",
	"grep",
	"bash",
	"git_status",
	"git_diff",
	"git_add",
	"git_commit",
	"web",
	"edit",
	"write",
]);

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

const BANNED_PATTERNS: Array<[RegExp, string]> = [
	[
		/ignore (all )?((previous|prior)( system| developer)?|system|developer) instructions/i,
		"instruction override",
	],
	[
		/reveal (the )?(system prompt|developer message|hidden instructions|secrets?)/i,
		"secret extraction",
	],
	[/exfiltrat/i, "data exfiltration"],
	[/jailbreak/i, "jailbreak behavior"],
	[/bypass (policy|permissions|sandbox|safety)/i, "policy bypass"],
	[/api[_ -]?key|access[_ -]?token|private[_ -]?key/i, "secret material"],
];

/** Lowercase, hyphenated, ASCII-only slug. Trimmed to 60 chars. */
export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
}

/** Tokenise into unique lowercase keyword set. Stopwords filtered. */
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

function yamlSafe(value: string): string {
	const oneline = value.replace(/[\r\n]+/g, " ").trim();
	if (/[:#{}[\]|>&*!%@`]/.test(oneline) || oneline.startsWith("'") || oneline.startsWith('"')) {
		return `"${oneline.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return oneline;
}

function normalizeSlash(value: string): string {
	const slug = slugify(value.replace(/^\//, ""));
	return slug ? `/${slug}` : "";
}

function normalizeTools(tools: string[] | undefined): string[] {
	const source = tools?.length ? tools : DEFAULT_TOOLS;
	const seen = new Set<string>();
	const out: string[] = [];
	for (const tool of source) {
		const normalized = tool.replace(/[^a-zA-Z0-9_-]/g, "");
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

function countBodyLines(markdown: string): number {
	const body = markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "");
	return body.split("\n").length;
}

function scanBanned(text: string): string[] {
	const hits: string[] = [];
	for (const [pattern, label] of BANNED_PATTERNS) {
		if (pattern.test(text)) hits.push(label);
	}
	return hits;
}

export function renderSkillMarkdown(input: CreateSkillInput, slug: string): string {
	const name = input.name ?? slug;
	const trigger = normalizeSlash(input.trigger ?? slug);
	const aliases = (input.aliases ?? [])
		.map(normalizeSlash)
		.filter((alias) => alias && alias !== trigger);
	const tools = normalizeTools(input.tools);

	const criteriaBlock = input.successCriteria
		.map((criterion) => `- ${criterion.replace(/[\r\n]+/g, " ").trim()}`)
		.join("\n");

	const examplesBlock = input.examples
		.map((example, index) => {
			return [
				`### Example ${index + 1}`,
				"",
				"Input:",
				"",
				"```",
				example.input.trim(),
				"```",
				"",
				"Output:",
				"",
				"```",
				example.output.trim(),
				"```",
			].join("\n");
		})
		.join("\n\n");

	const title = name.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
	const aliasesLine = aliases.length ? `\naliases: [${aliases.join(", ")}]` : "";

	return `---
name: ${yamlSafe(name)}
description: ${yamlSafe(input.taskDescription)}
trigger: ${trigger}${aliasesLine}
tools: [${tools.join(", ")}]
created: ${new Date().toISOString()}
self-authored: true
---

# ${title}

${input.taskDescription.replace(/[\r\n]{3,}/g, "\n\n").trim()}

## When To Use

${criteriaBlock}

## Workflow

1. Read the user's request and match it to the examples.
2. Apply the reusable workflow described by this skill.
3. Keep the output focused on the success criteria.
4. Ask for missing task-specific context only when required.

## Examples

${examplesBlock}

## Validation Notes

This skill was drafted by 8gent and must be user-approved before durable persistence. Delete this file if it stops being useful.
`;
}

export function validateSkillDraft(
	input: CreateSkillInput,
	slug: string,
	markdown: string,
): SkillCreationValidation {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!input.taskDescription || input.taskDescription.trim().length < 12) {
		errors.push("taskDescription must be at least 12 characters");
	}
	if (!Array.isArray(input.successCriteria) || input.successCriteria.length === 0) {
		errors.push("at least one successCriteria entry is required");
	}
	if (!Array.isArray(input.examples) || input.examples.length === 0) {
		errors.push("at least one example is required");
	}
	if (!slug) errors.push("skill slug could not be derived");
	if (slug.length > 60) errors.push("skill slug must be 60 characters or fewer");

	const trigger = normalizeSlash(input.trigger ?? slug);
	if (!trigger) errors.push("primary trigger could not be derived");

	for (const tool of normalizeTools(input.tools)) {
		if (!ALLOWED_TOOLS.has(tool)) errors.push(`tool is not allowed: ${tool}`);
	}

	const textForPolicy = [
		input.taskDescription,
		...(input.successCriteria ?? []),
		...(input.examples ?? []).flatMap((example) => [example.input, example.output]),
	].join("\n");
	for (const hit of scanBanned(textForPolicy)) {
		errors.push(`banned content detected: ${hit}`);
	}

	const lineCount = countBodyLines(markdown);
	if (lineCount > 160) warnings.push(`skill body is long (${lineCount} lines)`);
	if (lineCount < 20) warnings.push(`skill body is short (${lineCount} lines)`);

	if (!/^---\n[\s\S]*\n---\n/.test(markdown)) {
		errors.push("frontmatter block is missing");
	}
	if (!/^name:\s+/m.test(markdown)) errors.push("frontmatter missing name");
	if (!/^description:\s+/m.test(markdown)) {
		errors.push("frontmatter missing description");
	}
	if (!/^trigger:\s+\//m.test(markdown)) errors.push("frontmatter missing slash trigger");
	if (!/^self-authored:\s+true/m.test(markdown)) {
		errors.push("frontmatter missing self-authored marker");
	}

	return { passed: errors.length === 0, errors, warnings };
}

export function createSkillDraft(input: CreateSkillInput): SkillDraft {
	const slug = slugify(input.name ?? input.taskDescription);
	const root = input.skillsRoot ?? join(homedir(), ".8gent", "skills");
	const fileName = `${slug}.md`;
	const filePath = join(root, fileName);
	const markdown = renderSkillMarkdown(input, slug);
	const validation = validateSkillDraft(input, slug, markdown);

	if (existsSync(filePath) && !input.allowOverwrite) {
		validation.errors.push(`skill already exists: ${fileName}`);
		validation.passed = false;
	}

	return { slug, fileName, filePath, markdown, validation };
}

export async function createSkill(input: CreateSkillInput): Promise<CreateSkillResult> {
	const draft = createSkillDraft(input);
	if (!draft.validation.passed) {
		return { ...draft, path: null, requiresReload: false };
	}
	if (input.approved !== true) {
		return {
			...draft,
			validation: {
				passed: false,
				errors: ["explicit approval required before persistence"],
				warnings: draft.validation.warnings,
			},
			path: null,
			requiresReload: false,
		};
	}

	mkdirSync(input.skillsRoot ?? join(homedir(), ".8gent", "skills"), { recursive: true });
	writeFileSync(draft.filePath, draft.markdown);
	return { ...draft, path: draft.filePath, requiresReload: true };
}

/** Deterministic smoke score for examples. Kept for validation dashboards only. */
export function scoreCoverage(criteria: string[], examples: SkillExample[]): number {
	if (criteria.length === 0) return 0;
	const haystack = examples
		.flatMap((example) => [example.input, example.output])
		.join(" \n ")
		.toLowerCase();

	let covered = 0;
	for (const criterion of criteria) {
		const tokens = criterion
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((token) => token.length >= 4 && !STOPWORDS.has(token));
		if (tokens.length === 0 || tokens.some((token) => haystack.includes(token))) {
			covered++;
		}
	}
	return covered / criteria.length;
}
