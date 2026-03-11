/**
 * 8gent Code - Skills System
 *
 * Skills are markdown files with frontmatter that define reusable workflows.
 * They provide specialized prompts and tool configurations for common tasks.
 *
 * Skills location: ~/.8gent/skills/*.md
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
import * as path from "path";
import * as os from "os";

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

function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
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
        .map(item => item.trim())
        .filter(item => item.length > 0);
    } else {
      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
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

// ============================================
// Skill Manager
// ============================================

export class SkillManager {
  private skills: Map<string, Skill> = new Map();
  private skillsDirectory: string;
  private invocations: Map<string, SkillInvocation> = new Map();

  constructor(skillsDirectory?: string) {
    this.skillsDirectory = skillsDirectory || path.join(os.homedir(), ".8gent", "skills");
  }

  /**
   * Load all skills from the skills directory
   */
  async loadSkills(): Promise<Skill[]> {
    this.skills.clear();

    // Ensure directory exists
    if (!fs.existsSync(this.skillsDirectory)) {
      fs.mkdirSync(this.skillsDirectory, { recursive: true });
      // Create example skill
      this.createExampleSkill();
    }

    const files = fs.readdirSync(this.skillsDirectory);
    const skillFiles = files.filter(f => f.endsWith(".md"));

    const loadedSkills: Skill[] = [];

    for (const file of skillFiles) {
      const filePath = path.join(this.skillsDirectory, file);
      try {
        const skill = this.loadSkillFile(filePath);
        this.skills.set(skill.name, skill);
        loadedSkills.push(skill);
      } catch (err) {
        console.warn(`[skills] Failed to load ${file}: ${err}`);
      }
    }

    return loadedSkills;
  }

  /**
   * Load a single skill file
   */
  private loadSkillFile(filePath: string): Skill {
    const content = fs.readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);

    return {
      name: frontmatter.name,
      description: frontmatter.description || "",
      prompt: body.trim(),
      tools: frontmatter.tools || [],
      triggers: frontmatter.triggers || [],
      examples: frontmatter.examples || [],
      filePath,
    };
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
    return this.skills.get(name);
  }

  /**
   * Get all loaded skills
   */
  getAllSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Find skills matching a trigger
   */
  findByTrigger(trigger: string): Skill[] {
    const triggerLower = trigger.toLowerCase();
    return this.getAllSkills().filter(skill =>
      skill.triggers?.some(t => t.toLowerCase() === triggerLower)
    );
  }

  /**
   * Search skills by name or description
   */
  searchSkills(query: string): Skill[] {
    const queryLower = query.toLowerCase();
    return this.getAllSkills().filter(skill =>
      skill.name.toLowerCase().includes(queryLower) ||
      skill.description.toLowerCase().includes(queryLower)
    );
  }

  /**
   * Invoke a skill with arguments
   */
  async invokeSkill(
    name: string,
    args: Record<string, unknown>,
    executor: (prompt: string, tools: string[]) => Promise<unknown>
  ): Promise<SkillInvocation> {
    const skill = this.skills.get(name);
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
${skill.examples?.length ? `examples:\n${skill.examples.map(e => `  - ${e}`).join("\n")}` : ""}
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
export function parseSkillCommand(input: string): { name: string; args: Record<string, string> } | null {
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
      args[`_${Object.keys(args).filter(k => k.startsWith("_")).length}`] = part;
      i++;
    }
  }

  return { name, args };
}
