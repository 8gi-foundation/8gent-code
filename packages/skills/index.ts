/**
 * 8gent Code - Skills System
 *
 * Skills are markdown files with frontmatter that define reusable workflows.
 * They provide specialized prompts and tool configurations for common tasks.
 *
 * Skills load order (later steps skip if name already taken):
 * 1. ~/.8gent/skills/ flat .md files (user overrides all)
 * 2. Project: .claude/skills/<name>/SKILL.md under process.cwd() (repo overrides bundled defaults)
 * 3. Bundled: packages/skills/<name>/SKILL.md (dev) and dist/skills/<name>/SKILL.md (published CLI)
 *
 * Skill format:
 * ---
 * name: commit
 * description: Git commit workflow
 * tools: [git_status, git_add, git_commit]
 * ---
 * # Instructions
 * 1. Run git status
 * 2. Stage changed files
 * 3. Create commit message
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

// ============================================
// Types
// ============================================

export interface Skill {
	name: string;
	description: string;
	prompt: string;
	tools: string[];
	triggers?: string[];
	examples?: string[];
	filePath: string;
}

export interface SkillFrontmatter {
	name: string;
	description?: string;
	tools?: string[];
	triggers?: string[];
	/** Single primary slash trigger, e.g. /billiondollarboardroom */
	trigger?: string;
	/** Alternate slash commands, e.g. [/bdb, /billionboard] */
	aliases?: string[];
	examples?: string[];
}

export interface SkillInvocation {
	skillName: string;
	args: Record<string, unknown>;
	startedAt: Date;
	completedAt?: Date;
	status: "pending" | "running" | "completed" | "failed";
	result?: unknown;
	error?: string;
}

// ============================================
// Frontmatter Parser
// ============================================

function parseFrontmatter(content: string): {
	frontmatter: SkillFrontmatter;
	body: string;
} {
	const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
	const match = content.match(frontmatterRegex);

	if (!match) {
		throw new Error("Invalid skill format: missing frontmatter");
	}

	const frontmatterText = match[1];
	const body = match[2];

	// Parse YAML-like frontmatter (simple key: value pairs)
	const frontmatter: Record<string, unknown> = {};
	const lines = frontmatterText.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const colonIndex = trimmed.indexOf(":");
		if (colonIndex === -1) continue;

		const key = trimmed.slice(0, colonIndex).trim();
		let value = trimmed.slice(colonIndex + 1).trim();

		// Parse arrays: [item1, item2, item3]
		if (value.startsWith("[") && value.endsWith("]")) {
			const arrayContent = value.slice(1, -1);
			frontmatter[key] = arrayContent
				.split(",")
				.map((item) => item.trim())
				.filter((item) => item.length > 0);
		} else {
			// Remove surrounding quotes if present
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			frontmatter[key] = value;
		}
	}

	if (!frontmatter.name || typeof frontmatter.name !== "string") {
		throw new Error("Skill must have a 'name' field");
	}

	return {
		frontmatter: frontmatter as unknown as SkillFrontmatter,
		body,
	};
}

/** Each subfolder (or symlinked dir) may contain SKILL.md. */
function collectNestedSkillMdPaths(skillsRoot: string): string[] {
	if (!fs.existsSync(skillsRoot)) return [];
	const out: string[] = [];
	for (const name of fs.readdirSync(skillsRoot)) {
		const skillMd = path.join(skillsRoot, name, "SKILL.md");
		if (fs.existsSync(skillMd)) {
			out.push(skillMd);
		}
	}
	return out;
}

/** Skill markdown shipped with 8gent (source tree or copied next to dist/cli.js). */
function discoverBundledSkillMdFiles(): string[] {
	const entryDir = path.dirname(fileURLToPath(import.meta.url));
	const nested = [...collectNestedSkillMdPaths(entryDir)];
	nested.push(...collectNestedSkillMdPaths(path.join(entryDir, "skills")));
	return nested;
}

// ============================================
// Skill Manager
// ============================================

export class SkillManager {
	private skills: Map<string, Skill> = new Map();
	/** Normalized lookup key (no leading slash, lowercased) -> canonical skill name */
	private aliasToCanonical: Map<string, string> = new Map();
	private skillsDirectory: string;
	private invocations: Map<string, SkillInvocation> = new Map();

	constructor(skillsDirectory?: string) {
		this.skillsDirectory =
			skillsDirectory || path.join(os.homedir(), ".8gent", "skills");
	}

	/**
	 * Load all skills from the skills directory
	 */
	async loadSkills(): Promise<Skill[]> {
		this.skills.clear();
		this.aliasToCanonical.clear();

		// Ensure directory exists
		if (!fs.existsSync(this.skillsDirectory)) {
			fs.mkdirSync(this.skillsDirectory, { recursive: true });
			// Create example skill
			this.createExampleSkill();
		}

		const files = fs.readdirSync(this.skillsDirectory);
		const skillFiles = files.filter((f) => f.endsWith(".md"));

		for (const file of skillFiles) {
			this.tryIngestSkillFile(path.join(this.skillsDirectory, file), false);
		}

		const claudeSkillsRoot = path.join(process.cwd(), ".claude", "skills");
		for (const filePath of collectNestedSkillMdPaths(claudeSkillsRoot)) {
			this.tryIngestSkillFile(filePath, true);
		}

		for (const filePath of discoverBundledSkillMdFiles()) {
			this.tryIngestSkillFile(filePath, true);
		}

		return this.getAllSkills();
	}

	private registerLookupKeys(
		skillName: string,
		frontmatter: SkillFrontmatter,
	): void {
		const norm = (s: string) => s.replace(/^\//, "").toLowerCase();
		this.aliasToCanonical.set(norm(skillName), skillName);
		if (typeof frontmatter.trigger === "string") {
			const t = norm(frontmatter.trigger);
			if (t) this.aliasToCanonical.set(t, skillName);
		}
		if (Array.isArray(frontmatter.aliases)) {
			for (const a of frontmatter.aliases) {
				const t = norm(String(a));
				if (t) this.aliasToCanonical.set(t, skillName);
			}
		}
	}

	private buildSkillFromParsed(
		filePath: string,
		frontmatter: SkillFrontmatter,
		body: string,
	): Skill {
		const triggerExtras: string[] = [];
		if (
			typeof frontmatter.trigger === "string" &&
			frontmatter.trigger.startsWith("/")
		) {
			triggerExtras.push(frontmatter.trigger.slice(1));
		}
		return {
			name: frontmatter.name,
			description: frontmatter.description || "",
			prompt: body.trim(),
			tools: frontmatter.tools || [],
			triggers: [...triggerExtras, ...(frontmatter.triggers || [])],
			examples: frontmatter.examples || [],
			filePath,
		};
	}

	private tryIngestSkillFile(filePath: string, skipIfExists: boolean): void {
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			const { frontmatter, body } = parseFrontmatter(content);
			if (skipIfExists && this.skills.has(frontmatter.name)) return;
			const skill = this.buildSkillFromParsed(filePath, frontmatter, body);
			this.skills.set(skill.name, skill);
			this.registerLookupKeys(skill.name, frontmatter);
		} catch (err) {
			console.warn(`[skills] Failed to load ${filePath}: ${err}`);
		}
	}

	/**
	 * Create an example skill file
	 */
	private createExampleSkill(): void {
		const exampleSkill = `---
name: commit
description: Smart git commit workflow with conventional commits
tools: [git_status, git_diff, git_add, git_commit]
triggers: [commit, save, checkpoint]
examples:
  - /commit "feat: add user authentication"
  - /commit (auto-generates message)
---
# Git Commit Skill

## Instructions

1. Run git status to see current changes
2. Run git diff to understand what changed
3. Stage appropriate files with git add
4. Generate a conventional commit message based on changes:
   - feat: new feature
   - fix: bug fix
   - docs: documentation
   - style: formatting
   - refactor: code restructuring
   - test: adding tests
   - chore: maintenance
5. Create the commit

## Rules

- Keep commit messages concise (50 chars or less for subject)
- Use present tense ("add feature" not "added feature")
- Don't commit node_modules, .env, or other sensitive files
- Group related changes into single commits
`;

		const filePath = path.join(this.skillsDirectory, "commit.md");
		fs.writeFileSync(filePath, exampleSkill);
		console.log(`[skills] Created example skill: ${filePath}`);
	}

	/**
	 * Get a skill by name
	 */
	getSkill(name: string): Skill | undefined {
		const key = name.replace(/^\//, "").toLowerCase();
		const canonical = this.aliasToCanonical.get(key);
		if (canonical) {
			const s = this.skills.get(canonical);
			if (s) return s;
		}
		const direct = this.skills.get(name);
		if (direct) return direct;
		return [...this.skills.values()].find((s) => s.name.toLowerCase() === key);
	}

	/**
	 * Get all loaded skills
	 */
	getAllSkills(): Skill[] {
		return Array.from(this.skills.values());
	}

	/**
	 * Every `/token` that resolves via getSkill (canonical name + alias keys). Longest first for completion UI.
	 */
	getSkillSlashTriggers(): string[] {
		const prefixes = new Set<string>();
		for (const skill of this.skills.values()) {
			prefixes.add(`/${skill.name}`);
		}
		for (const key of this.aliasToCanonical.keys()) {
			prefixes.add(`/${key}`);
		}
		return [...prefixes].sort((a, b) => b.length - a.length);
	}

	/**
	 * Find skills matching a trigger
	 */
	findByTrigger(trigger: string): Skill[] {
		const triggerLower = trigger.toLowerCase();
		return this.getAllSkills().filter((skill) =>
			skill.triggers?.some((t) => t.toLowerCase() === triggerLower),
		);
	}

	/**
	 * Search skills by name or description
	 */
	searchSkills(query: string): Skill[] {
		const queryLower = query.toLowerCase();
		return this.getAllSkills().filter(
			(skill) =>
				skill.name.toLowerCase().includes(queryLower) ||
				skill.description.toLowerCase().includes(queryLower),
		);
	}

	/**
	 * Invoke a skill with arguments
	 */
	async invokeSkill(
		name: string,
		args: Record<string, unknown>,
		executor: (prompt: string, tools: string[]) => Promise<unknown>,
	): Promise<SkillInvocation> {
		const skill = this.getSkill(name);
		if (!skill) {
			throw new Error(`Skill not found: ${name}`);
		}

		const invocationId = `${name}-${Date.now()}`;
		const invocation: SkillInvocation = {
			skillName: name,
			args,
			startedAt: new Date(),
			status: "running",
		};

		this.invocations.set(invocationId, invocation);

		try {
			// Build the full prompt with skill instructions and args
			let fullPrompt = skill.prompt;

			// Append args as context
			if (Object.keys(args).length > 0) {
				fullPrompt += `\n\n## Context\n${JSON.stringify(args, null, 2)}`;
			}

			// Execute through the provided executor
			const result = await executor(fullPrompt, skill.tools);

			invocation.status = "completed";
			invocation.completedAt = new Date();
			invocation.result = result;
		} catch (err) {
			invocation.status = "failed";
			invocation.completedAt = new Date();
			invocation.error = err instanceof Error ? err.message : String(err);
		}

		return invocation;
	}

	/**
	 * Add a skill programmatically
	 */
	addSkill(skill: Skill): void {
		this.skills.set(skill.name, skill);
	}

	/**
	 * Remove a skill
	 */
	removeSkill(name: string): boolean {
		return this.skills.delete(name);
	}

	/**
	 * Save a skill to disk
	 */
	saveSkill(skill: Skill): void {
		const content = `---
name: ${skill.name}
description: ${skill.description}
tools: [${skill.tools.join(", ")}]
${skill.triggers?.length ? `triggers: [${skill.triggers.join(", ")}]` : ""}
${skill.examples?.length ? `examples:\n${skill.examples.map((e) => `  - ${e}`).join("\n")}` : ""}
---
${skill.prompt}
`;

		const fileName = `${skill.name.toLowerCase().replace(/\s+/g, "-")}.md`;
		const filePath = path.join(this.skillsDirectory, fileName);
		fs.writeFileSync(filePath, content);
		skill.filePath = filePath;
		this.skills.set(skill.name, skill);
	}

	/**
	 * Get skill invocation history
	 */
	getInvocationHistory(): SkillInvocation[] {
		return Array.from(this.invocations.values());
	}

	/**
	 * Get skills directory path
	 */
	getSkillsDirectory(): string {
		return this.skillsDirectory;
	}

	/**
	 * Reload skills from disk
	 */
	async reloadSkills(): Promise<Skill[]> {
		return this.loadSkills();
	}

	/**
	 * Get skill count
	 */
	get size(): number {
		return this.skills.size;
	}
}

// ============================================
// Singleton Instance
// ============================================

let skillManagerInstance: SkillManager | null = null;

export function getSkillManager(skillsDirectory?: string): SkillManager {
	if (!skillManagerInstance) {
		skillManagerInstance = new SkillManager(skillsDirectory);
	}
	return skillManagerInstance;
}

export function resetSkillManager(): void {
	skillManagerInstance = null;
}

// ============================================
// Utility Functions
// ============================================

/**
 * Parse skill command from user input
 * e.g., "/commit -m 'feat: add feature'" -> { name: "commit", args: { m: "feat: add feature" } }
 */
export function parseSkillCommand(
	input: string,
): { name: string; args: Record<string, string> } | null {
	if (!input.startsWith("/")) return null;

	const parts = input.slice(1).split(/\s+/);
	const name = parts[0];
	const args: Record<string, string> = {};

	let i = 1;
	while (i < parts.length) {
		const part = parts[i];

		if (part.startsWith("-")) {
			const key = part.replace(/^-+/, "");
			// Check if next part is the value
			if (i + 1 < parts.length && !parts[i + 1].startsWith("-")) {
				// Handle quoted values
				let value = parts[i + 1];
				if (value.startsWith('"') || value.startsWith("'")) {
					const quote = value[0];
					const valueParts = [value.slice(1)];
					i += 2;
					while (i < parts.length && !parts[i - 1].endsWith(quote)) {
						valueParts.push(parts[i]);
						i++;
					}
					value = valueParts.join(" ").replace(/['"]$/, "");
				} else {
					i += 2;
				}
				args[key] = value;
			} else {
				args[key] = "true";
				i++;
			}
		} else {
			// Positional argument
			args[`_${Object.keys(args).filter((k) => k.startsWith("_")).length}`] =
				part;
			i++;
		}
	}

	return { name, args };
}
