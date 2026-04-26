/**
 * Autonomous Task Executor
 *
 * Takes a real task (GitHub issue, user request, or self-discovered work),
 * generates code, tests it in a secure sandbox, and ships the result.
 *
 * This is Eight working for real - not benchmarks, not demos.
 *
 * Flow:
 *   1. Receive task (issue URL, description, or auto-discovered)
 *   2. Analyze the codebase context (AST, blast radius)
 *   3. Generate a plan (what files to touch, what tests to write)
 *   4. Generate code in a git worktree (isolated branch)
 *   5. Execute tests in secure sandbox
 *   6. If tests pass: commit, push, open PR
 *   7. If tests fail: analyze failure, mutate, retry (max 3)
 *   8. Report result via Telegram
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import {
	type ExecutionResult,
	executeAndValidate,
	executeSecure,
} from "./sandbox";

/**
 * Validate generated TypeScript files before committing.
 * Catches: markdown in .tsx, CommonJS, missing default exports, broken syntax.
 */
function validateGeneratedFiles(
	files: Array<{ path: string; content: string }>,
	workDir: string,
): { valid: boolean; errors: string[] } {
	const errors: string[] = [];

	for (const file of files) {
		if (!/\.(ts|tsx)$/.test(file.path)) continue;

		const trimmed = file.content.trim();
		const name = basename(file.path);

		// Reject markdown in code files
		if (trimmed.startsWith("# ") || trimmed.startsWith("## ")) {
			errors.push(`${file.path}: contains markdown, not TypeScript`);
			continue;
		}

		// Reject CommonJS
		if (/\bmodule\.exports\s*=/.test(file.content)) {
			errors.push(`${file.path}: uses CommonJS module.exports — must use ESM`);
			continue;
		}

		// Reject Pages Router patterns in App Router files
		if (
			/\bNextApiRequest\b/.test(file.content) ||
			/\bNextApiResponse\b/.test(file.content)
		) {
			errors.push(`${file.path}: uses Pages Router types — this is App Router`);
			continue;
		}

		// page.tsx / layout.tsx must have default component export
		if (name === "page.tsx" || name === "layout.tsx") {
			const hasDefault =
				/export\s+default\s+(function|class|async\s+function)/.test(
					file.content,
				) || /export\s+default\s+\w+/.test(file.content);
			if (!hasDefault) {
				errors.push(
					`${file.path}: missing default export (required for Next.js App Router)`,
				);
				continue;
			}
		}

		// Try transpile
		const fullPath = join(workDir, file.path);
		if (existsSync(fullPath)) {
			try {
				execSync(
					`bun build "${fullPath}" --no-bundle --outdir /tmp/.8gent-validate 2>&1`,
					{
						cwd: workDir,
						encoding: "utf-8",
						timeout: 15000,
					},
				);
			} catch (err: any) {
				const msg = (err.stderr || err.stdout || err.message || "").slice(
					0,
					200,
				);
				errors.push(`${file.path}: transpile failed — ${msg}`);
			}
		}
	}

	return { valid: errors.length === 0, errors };
}

const OLLAMA_URL = "http://localhost:11434/api/chat";

export interface Task {
	id: string;
	title: string;
	description: string;
	source: "github" | "user" | "self";
	repo?: string;
	issueNumber?: number;
	priority?: "low" | "medium" | "high" | "critical";
}

export interface TaskResult {
	task: Task;
	success: boolean;
	branch?: string;
	prUrl?: string;
	filesChanged: string[];
	testsPassed: number;
	testsFailed: number;
	attempts: number;
	durationMs: number;
	error?: string;
}

interface GeneratedCode {
	files: Array<{ path: string; content: string }>;
	tests: Array<{ path: string; content: string }>;
	explanation: string;
}

async function callModel(
	messages: Array<{ role: string; content: string }>,
	model = "devstral:latest",
): Promise<string> {
	const res = await fetch(OLLAMA_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages,
			stream: false,
			options: { num_predict: 8192, temperature: 0.3 },
		}),
		signal: AbortSignal.timeout(300_000),
	});

	if (!res.ok) throw new Error(`Model error: ${res.status}`);
	const data = (await res.json()) as any;
	return data.message?.content || "";
}

export async function executeTask(
	task: Task,
	repoPath: string,
	options: { maxAttempts?: number; model?: string; dryRun?: boolean } = {},
): Promise<TaskResult> {
	const {
		maxAttempts = 3,
		model = "devstral:latest",
		dryRun = false,
	} = options;
	const start = performance.now();
	const branchName = `eight/${task.id}-${Date.now()}`;

	let attempts = 0;
	let lastError: string | undefined;
	let filesChanged: string[] = [];
	let testsPassed = 0;
	let testsFailed = 0;

	try {
		// Step 1: Create worktree for isolation
		const worktreePath = join(
			repoPath,
			".8gent",
			"worktrees",
			branchName.replace(/\//g, "-"),
		);

		if (!dryRun) {
			mkdirSync(join(repoPath, ".8gent", "worktrees"), { recursive: true });
			execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, {
				cwd: repoPath,
				stdio: "pipe",
			});
		}

		const workDir = dryRun ? repoPath : worktreePath;

		// Step 2: Read context
		const contextFiles = getRelevantContext(workDir, task.description);

		// Step 3-6: Generate, test, retry loop
		while (attempts < maxAttempts) {
			attempts++;

			// Generate code
			const generated = await generateCode(
				task,
				contextFiles,
				model,
				lastError,
			);

			if (!generated.files.length) {
				lastError = "Model generated no files";
				continue;
			}

			// Write files
			filesChanged = [];
			for (const file of generated.files) {
				const filePath = join(workDir, file.path);
				mkdirSync(join(filePath, ".."), { recursive: true });
				writeFileSync(filePath, file.content);
				filesChanged.push(file.path);
			}

			// Write tests
			for (const test of generated.tests) {
				const testPath = join(workDir, test.path);
				mkdirSync(join(testPath, ".."), { recursive: true });
				writeFileSync(testPath, test.content);
			}

			// Run tests in sandbox
			if (generated.tests.length > 0) {
				const testCode = generated.tests.map((t) => t.content).join("\n\n");
				const result = await executeSecure(testCode, { timeout: 10000 });

				if (result.success) {
					testsPassed = generated.tests.length;
					testsFailed = 0;
					lastError = undefined;
					break;
				} else {
					testsFailed = generated.tests.length;
					lastError = result.error || "Tests failed";
				}
			} else {
				// No tests generated - verify code at least parses
				const parseCheck = await executeSecure(
					`${generated.files.map((f) => f.content).join("\n")}; console.log("OK");`,
					{ timeout: 5000 },
				);

				if (parseCheck.success) {
					testsPassed = 1;
					lastError = undefined;
					break;
				} else {
					lastError = parseCheck.error || "Code failed to parse";
				}
			}
		}

		// Step 7: Validate and ship
		if (!lastError && !dryRun) {
			// Validate code before committing
			const validation = validateGeneratedFiles(
				filesChanged.map((f) => ({
					path: f,
					content: readFileSync(join(workDir, f), "utf-8"),
				})),
				workDir,
			);
			if (!validation.valid) {
				lastError = `Code validation failed:\n${validation.errors.join("\n")}`;
			}
		}

		if (!lastError && !dryRun) {
			// Commit
			execSync(
				`git add -A && git commit -m "feat: ${task.title}\n\nResolved by Eight autonomously.\nTask: ${task.id}"`,
				{
					cwd: workDir,
					stdio: "pipe",
				},
			);

			// Push
			execSync(`git push origin "${branchName}"`, {
				cwd: workDir,
				stdio: "pipe",
			});

			// Open PR
			let prUrl: string | undefined;
			try {
				const prOutput = execSync(
					`gh pr create --title "${task.title}" --body "Resolved autonomously by Eight.\n\nTask: ${task.id}\nAttempts: ${attempts}\nFiles: ${filesChanged.join(", ")}" --head "${branchName}"`,
					{ cwd: workDir, encoding: "utf-8", stdio: "pipe" },
				);
				prUrl = prOutput.trim();
			} catch {
				// PR creation failed - still a success if code is pushed
			}

			// Clean up worktree
			execSync(`git worktree remove "${worktreePath}" --force`, {
				cwd: repoPath,
				stdio: "pipe",
			});

			return {
				task,
				success: true,
				branch: branchName,
				prUrl,
				filesChanged,
				testsPassed,
				testsFailed,
				attempts,
				durationMs: Math.round(performance.now() - start),
			};
		}

		// Clean up worktree on failure
		if (!dryRun && existsSync(worktreePath)) {
			execSync(`git worktree remove "${worktreePath}" --force`, {
				cwd: repoPath,
				stdio: "pipe",
			});
		}

		return {
			task,
			success: false,
			filesChanged,
			testsPassed,
			testsFailed,
			attempts,
			durationMs: Math.round(performance.now() - start),
			error: lastError,
		};
	} catch (err: any) {
		return {
			task,
			success: false,
			filesChanged,
			testsPassed,
			testsFailed,
			attempts,
			durationMs: Math.round(performance.now() - start),
			error: err.message,
		};
	}
}

function getRelevantContext(repoPath: string, taskDescription: string): string {
	// Read package.json for project info
	let context = "";
	const pkgPath = join(repoPath, "package.json");
	if (existsSync(pkgPath)) {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		context += `Project: ${pkg.name}\nDeps: ${Object.keys(pkg.dependencies || {}).join(", ")}\n\n`;
	}

	// Read README for context
	const readmePath = join(repoPath, "README.md");
	if (existsSync(readmePath)) {
		context += readFileSync(readmePath, "utf-8").slice(0, 2000) + "\n\n";
	}

	// Read CLAUDE.md if exists
	const claudePath = join(repoPath, "CLAUDE.md");
	if (existsSync(claudePath)) {
		context += readFileSync(claudePath, "utf-8").slice(0, 3000) + "\n\n";
	}

	return context;
}

async function generateCode(
	task: Task,
	context: string,
	model: string,
	previousError?: string,
): Promise<GeneratedCode> {
	const systemPrompt = `You are Eight, an autonomous coding agent. You write production-quality TypeScript code.

RULES:
1. Output ONLY code files. No explanations outside code blocks.
2. Each file in a separate fenced block with the path: \`\`\`typescript // src/auth.ts
3. Include at least one test file (path ending in .test.ts)
4. Handle edge cases. Export main functions.
5. No purple colors, no em dashes, no hardcoded secrets.

PROJECT CONTEXT:
${context}`;

	let userPrompt = `TASK: ${task.title}\n\n${task.description}`;

	if (previousError) {
		userPrompt += `\n\nPREVIOUS ATTEMPT FAILED: ${previousError}\nFix the issue and try again.`;
	}

	const response = await callModel(
		[
			{ role: "system", content: systemPrompt },
			{ role: "user", content: userPrompt },
		],
		model,
	);

	// Parse response into files
	const files: Array<{ path: string; content: string }> = [];
	const tests: Array<{ path: string; content: string }> = [];

	// Try strict format first: ```typescript // path/to/file.ts
	const strictBlocks = response.matchAll(
		/```(?:typescript|ts|javascript|js)\s*\/\/\s*(\S+)\n([\s\S]*?)```/g,
	);
	for (const match of strictBlocks) {
		const filePath = match[1].trim();
		const content = match[2].trim();
		if (filePath.includes(".test.")) {
			tests.push({ path: filePath, content });
		} else {
			files.push({ path: filePath, content });
		}
	}

	// Fallback: try any fenced code block with a file path comment on the first line
	if (files.length === 0 && tests.length === 0) {
		const looseBlocks = response.matchAll(
			/```(?:typescript|ts|javascript|js)?\n(\/\/\s*(\S+\.(?:ts|tsx|js|jsx))\n[\s\S]*?)```/g,
		);
		for (const match of looseBlocks) {
			const content = match[1].trim();
			const filePath = match[2].trim();
			if (filePath.includes(".test.")) {
				tests.push({ path: filePath, content });
			} else {
				files.push({ path: filePath, content });
			}
		}
	}

	// If still no files extracted, the model output is unparseable
	if (files.length === 0) {
		console.warn(
			"[autonomous] model output contained no parseable code blocks",
		);
	}

	return { files, tests, explanation: "" };
}
