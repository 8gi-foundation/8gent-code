/**
 * 8gent Code - Git Workflow Integration
 *
 * Ensures commits follow conventional commits, proper branch naming,
 * and generates detailed PR descriptions.
 */

// ============================================
// Types
// ============================================

export type CommitType =
	| "feat" // New feature
	| "fix" // Bug fix
	| "docs" // Documentation only
	| "style" // Formatting, no code change
	| "refactor" // Code change that neither fixes nor adds feature
	| "perf" // Performance improvement
	| "test" // Adding tests
	| "chore" // Maintenance
	| "ci" // CI/CD changes
	| "build"; // Build system changes

export interface ConventionalCommit {
	type: CommitType;
	scope?: string;
	description: string;
	body?: string;
	breaking?: boolean;
	issues?: string[];
	coAuthors?: string[];
}

export interface BranchConfig {
	prefix: string;
	name: string;
	issue?: string;
}

export interface PRDescription {
	title: string;
	summary: string;
	changes: string[];
	testPlan: string[];
	screenshots?: string[];
	breakingChanges?: string[];
	issues?: string[];
}

// ============================================
// Commit Message Generation
// ============================================

/**
 * Infer commit type from task description or changes
 */
export function inferCommitType(description: string): CommitType {
	const desc = description.toLowerCase();

	if (desc.includes("fix") || desc.includes("bug") || desc.includes("error")) {
		return "fix";
	}
	if (desc.includes("test") || desc.includes("spec") || desc.includes("coverage")) {
		return "test";
	}
	if (desc.includes("doc") || desc.includes("readme") || desc.includes("comment")) {
		return "docs";
	}
	if (desc.includes("refactor") || desc.includes("clean") || desc.includes("simplify")) {
		return "refactor";
	}
	if (desc.includes("perf") || desc.includes("optim") || desc.includes("faster")) {
		return "perf";
	}
	if (desc.includes("style") || desc.includes("format") || desc.includes("lint")) {
		return "style";
	}
	if (desc.includes("build") || desc.includes("webpack") || desc.includes("vite")) {
		return "build";
	}
	if (desc.includes("ci") || desc.includes("pipeline") || desc.includes("action")) {
		return "ci";
	}
	if (desc.includes("chore") || desc.includes("deps") || desc.includes("upgrade")) {
		return "chore";
	}

	return "feat"; // Default to feature
}

/**
 * Extract scope from file paths
 */
export function inferScope(files: string[]): string | undefined {
	if (files.length === 0) return undefined;

	// Find common directory
	const directories = files.map((f) => {
		const parts = f.split("/");
		// Return the most meaningful directory (skip src/, lib/, etc.)
		const skipDirs = ["src", "lib", "app", "packages", "."];
		for (const part of parts) {
			if (!skipDirs.includes(part)) {
				return part;
			}
		}
		return parts[1] || parts[0];
	});

	// Count occurrences
	const counts = new Map<string, number>();
	for (const dir of directories) {
		counts.set(dir, (counts.get(dir) || 0) + 1);
	}

	// Return most common
	let maxCount = 0;
	let scope: string | undefined;
	for (const [dir, count] of counts) {
		if (count > maxCount) {
			maxCount = count;
			scope = dir;
		}
	}

	return scope;
}

/**
 * Generate a conventional commit message
 */
export function generateCommitMessage(commit: ConventionalCommit): string {
	let message = commit.type;

	if (commit.scope) {
		message += `(${commit.scope})`;
	}

	if (commit.breaking) {
		message += "!";
	}

	message += `: ${commit.description}`;

	if (commit.body) {
		message += `\n\n${commit.body}`;
	}

	if (commit.breaking) {
		message += `\n\nBREAKING CHANGE: ${commit.description}`;
	}

	if (commit.issues?.length) {
		message += `\n\nCloses: ${commit.issues.join(", ")}`;
	}

	if (commit.coAuthors?.length) {
		message += "\n";
		for (const author of commit.coAuthors) {
			message += `\nCo-Authored-By: ${author}`;
		}
	}

	return message;
}

/**
 * Parse a conventional commit message
 */
export function parseCommitMessage(message: string): ConventionalCommit | null {
	const headerPattern = /^(\w+)(?:\(([^)]+)\))?(!)?: (.+)$/;
	const lines = message.split("\n");
	const headerMatch = lines[0].match(headerPattern);

	if (!headerMatch) return null;

	const [, type, scope, breaking, description] = headerMatch;

	// Validate type
	const validTypes: CommitType[] = [
		"feat",
		"fix",
		"docs",
		"style",
		"refactor",
		"perf",
		"test",
		"chore",
		"ci",
		"build",
	];
	if (!validTypes.includes(type as CommitType)) return null;

	const commit: ConventionalCommit = {
		type: type as CommitType,
		scope: scope || undefined,
		description,
		breaking: !!breaking,
	};

	// Parse body
	const bodyLines: string[] = [];
	const issues: string[] = [];
	const coAuthors: string[] = [];

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];

		if (line.startsWith("Co-Authored-By:")) {
			coAuthors.push(line.replace("Co-Authored-By:", "").trim());
		} else if (line.startsWith("Closes:") || line.startsWith("Fixes:")) {
			const issueRefs = line.replace(/^(Closes|Fixes):/, "").trim();
			issues.push(...issueRefs.split(",").map((i) => i.trim()));
		} else if (line.startsWith("BREAKING CHANGE:")) {
			commit.breaking = true;
		} else if (line.trim()) {
			bodyLines.push(line);
		}
	}

	if (bodyLines.length > 0) {
		commit.body = bodyLines.join("\n");
	}
	if (issues.length > 0) {
		commit.issues = issues;
	}
	if (coAuthors.length > 0) {
		commit.coAuthors = coAuthors;
	}

	return commit;
}

// ============================================
// Branch Naming
// ============================================

/**
 * Generate a branch name from task description
 */
export function generateBranchName(config: BranchConfig): string {
	const prefix = config.prefix || "feature";
	let name = config.name
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.slice(0, 40);

	// Remove trailing hyphens
	name = name.replace(/-+$/, "");

	let branch = `${prefix}/${name}`;

	if (config.issue) {
		branch = `${prefix}/${config.issue}-${name}`;
	}

	return branch;
}

/**
 * Infer branch prefix from task type
 */
export function inferBranchPrefix(taskDescription: string): string {
	const desc = taskDescription.toLowerCase();

	if (desc.includes("fix") || desc.includes("bug")) return "fix";
	if (desc.includes("hotfix") || desc.includes("urgent")) return "hotfix";
	if (desc.includes("refactor")) return "refactor";
	if (desc.includes("doc")) return "docs";
	if (desc.includes("test")) return "test";
	if (desc.includes("chore") || desc.includes("deps")) return "chore";

	return "feature";
}

/**
 * Validate branch name
 */
export function validateBranchName(name: string): {
	valid: boolean;
	errors: string[];
} {
	const errors: string[] = [];

	// Check for valid characters
	if (!/^[a-z0-9][a-z0-9\-\/]*[a-z0-9]$/.test(name)) {
		errors.push("Branch name must start and end with alphanumeric, contain only a-z, 0-9, -, /");
	}

	// Check for consecutive special characters
	if (/[-\/]{2,}/.test(name)) {
		errors.push("Branch name cannot have consecutive - or /");
	}

	// Check length
	if (name.length > 100) {
		errors.push("Branch name too long (max 100 characters)");
	}

	// Check for proper prefix
	const validPrefixes = [
		"feature",
		"fix",
		"hotfix",
		"refactor",
		"docs",
		"test",
		"chore",
		"release",
	];
	const prefix = name.split("/")[0];
	if (!validPrefixes.includes(prefix)) {
		errors.push(`Invalid prefix. Use one of: ${validPrefixes.join(", ")}`);
	}

	return { valid: errors.length === 0, errors };
}

// ============================================
// PR Description Generation
// ============================================

/**
 * Generate a PR description from changes
 */
export function generatePRDescription(
	title: string,
	changes: {
		files: string[];
		commits: ConventionalCommit[];
		task?: string;
	},
): PRDescription {
	const summary = changes.task || `This PR ${title.toLowerCase()}`;

	// Group changes by type
	const changesByType = new Map<CommitType, string[]>();
	for (const commit of changes.commits) {
		const list = changesByType.get(commit.type) || [];
		list.push(commit.description);
		changesByType.set(commit.type, list);
	}

	// Build change list
	const changeList: string[] = [];
	const typeLabels: Record<CommitType, string> = {
		feat: "Features",
		fix: "Bug Fixes",
		docs: "Documentation",
		style: "Style",
		refactor: "Refactoring",
		perf: "Performance",
		test: "Tests",
		chore: "Chores",
		ci: "CI/CD",
		build: "Build",
	};

	for (const [type, descriptions] of changesByType) {
		changeList.push(`### ${typeLabels[type]}`);
		for (const desc of descriptions) {
			changeList.push(`- ${desc}`);
		}
	}

	// Generate test plan
	const testPlan: string[] = [];

	// Check if there are test files changed
	const testFiles = changes.files.filter(
		(f) => f.includes(".test.") || f.includes(".spec.") || f.includes("__tests__"),
	);

	if (testFiles.length > 0) {
		testPlan.push("- [ ] Tests pass locally (`npm test`)");
	}

	testPlan.push("- [ ] Code compiles without errors (`tsc --noEmit`)");
	testPlan.push("- [ ] Manual verification of changes");

	// Check for UI changes
	const uiFiles = changes.files.filter(
		(f) => f.endsWith(".tsx") || f.endsWith(".css") || f.endsWith(".scss"),
	);
	if (uiFiles.length > 0) {
		testPlan.push("- [ ] Visual inspection of UI changes");
	}

	// Check for breaking changes
	const breakingChanges = changes.commits.filter((c) => c.breaking).map((c) => c.description);

	// Extract issues
	const issues = changes.commits
		.flatMap((c) => c.issues || [])
		.filter((v, i, a) => a.indexOf(v) === i); // Dedupe

	return {
		title,
		summary,
		changes: changeList,
		testPlan,
		breakingChanges: breakingChanges.length > 0 ? breakingChanges : undefined,
		issues: issues.length > 0 ? issues : undefined,
	};
}

/**
 * Format PR description as markdown
 */
export function formatPRDescription(pr: PRDescription): string {
	const lines: string[] = [];

	lines.push("## Summary");
	lines.push("");
	lines.push(pr.summary);
	lines.push("");

	if (pr.changes.length > 0) {
		lines.push("## Changes");
		lines.push("");
		lines.push(...pr.changes);
		lines.push("");
	}

	if (pr.breakingChanges?.length) {
		lines.push("## Breaking Changes");
		lines.push("");
		for (const change of pr.breakingChanges) {
			lines.push(`- ${change}`);
		}
		lines.push("");
	}

	lines.push("## Test Plan");
	lines.push("");
	for (const step of pr.testPlan) {
		lines.push(step);
	}
	lines.push("");

	if (pr.issues?.length) {
		lines.push("## Related Issues");
		lines.push("");
		for (const issue of pr.issues) {
			lines.push(`- ${issue}`);
		}
		lines.push("");
	}

	lines.push("---");
	lines.push("Generated with [8gent](https://github.com/8gent-app/8gent-code)");

	return lines.join("\n");
}

// ============================================
// Git Workflow Manager
// ============================================

export class GitWorkflowManager {
	private currentBranch = "main";
	private stagedFiles: string[] = [];
	private commits: ConventionalCommit[] = [];

	/**
	 * Create a feature branch from task
	 */
	createFeatureBranch(task: string, issue?: string): string {
		const prefix = inferBranchPrefix(task);
		const branch = generateBranchName({
			prefix,
			name: task,
			issue,
		});

		this.currentBranch = branch;
		return branch;
	}

	/**
	 * Stage files
	 */
	stageFiles(files: string[]): void {
		this.stagedFiles = Array.from(new Set([...this.stagedFiles, ...files]));
	}

	/**
	 * Create commit from task
	 */
	createCommit(task: string, files?: string[]): ConventionalCommit {
		const type = inferCommitType(task);
		const scope = inferScope(files || this.stagedFiles);

		const commit: ConventionalCommit = {
			type,
			scope,
			description: this.generateDescription(task),
			coAuthors: ["8gent <8gent@example.com>"],
		};

		this.commits.push(commit);
		this.stagedFiles = [];

		return commit;
	}

	/**
	 * Generate PR for current branch
	 */
	generatePR(task: string): PRDescription {
		const title = this.generatePRTitle(task);

		return generatePRDescription(title, {
			files: this.getAllChangedFiles(),
			commits: this.commits,
			task,
		});
	}

	/**
	 * Get formatted commit message
	 */
	getCommitMessage(commit: ConventionalCommit): string {
		return generateCommitMessage(commit);
	}

	/**
	 * Get formatted PR body
	 */
	getPRBody(pr: PRDescription): string {
		return formatPRDescription(pr);
	}

	/**
	 * Validate commit message
	 */
	validateCommit(message: string): { valid: boolean; errors: string[] } {
		const parsed = parseCommitMessage(message);
		const errors: string[] = [];

		if (!parsed) {
			errors.push("Invalid conventional commit format");
			return { valid: false, errors };
		}

		// Check description length
		if (parsed.description.length < 10) {
			errors.push("Description too short (min 10 characters)");
		}
		if (parsed.description.length > 72) {
			errors.push("Description too long (max 72 characters)");
		}

		// Check for imperative mood (basic check)
		const firstWord = parsed.description.split(" ")[0].toLowerCase();
		const badPrefixes = ["added", "fixed", "updated", "changed", "removed"];
		if (badPrefixes.includes(firstWord)) {
			errors.push("Use imperative mood (e.g., 'add' not 'added')");
		}

		return { valid: errors.length === 0, errors };
	}

	// Private helpers

	private generateDescription(task: string): string {
		// Clean up task description for commit message
		let desc = task
			.replace(/^(fix|add|create|update|remove|implement|refactor)\s+/i, "")
			.toLowerCase();

		// Capitalize first letter
		desc = desc.charAt(0).toLowerCase() + desc.slice(1);

		// Trim to reasonable length
		if (desc.length > 50) {
			desc = `${desc.slice(0, 47)}...`;
		}

		return desc;
	}

	private generatePRTitle(task: string): string {
		const type = inferCommitType(task);
		const typeEmoji: Record<CommitType, string> = {
			feat: "✨",
			fix: "🐛",
			docs: "📚",
			style: "💅",
			refactor: "♻️",
			perf: "⚡",
			test: "🧪",
			chore: "🔧",
			ci: "🔄",
			build: "📦",
		};

		const emoji = typeEmoji[type];
		let title = task.slice(0, 60);

		// Clean up title
		title = title.replace(/^(fix|add|create|update|implement)\s+/i, "");
		title = title.charAt(0).toUpperCase() + title.slice(1);

		return `${emoji} ${title}`;
	}

	private getAllChangedFiles(): string[] {
		// In a real implementation, this would query git
		return this.stagedFiles;
	}
}

// ============================================
// Singleton
// ============================================

let gitWorkflowInstance: GitWorkflowManager | null = null;

export function getGitWorkflow(): GitWorkflowManager {
	if (!gitWorkflowInstance) {
		gitWorkflowInstance = new GitWorkflowManager();
	}
	return gitWorkflowInstance;
}

export function resetGitWorkflow(): void {
	gitWorkflowInstance = null;
}
