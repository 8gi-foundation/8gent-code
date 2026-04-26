/**
 * 8gent Code Benchmark Grader
 *
 * Comprehensive grading logic for all benchmark categories.
 */

import * as fs from "fs";
import * as path from "path";
import type {
	BenchmarkDefinition,
	BenchmarkResult,
	CheckResult,
	GradeResult,
	RubricCheck,
	ExecutionResult,
} from "./types";

/**
 * Main grader class for evaluating benchmark outputs
 */
export class BenchmarkGrader {
	private workDir: string;

	constructor(workDir: string) {
		this.workDir = workDir;
	}

	/**
	 * Grade a benchmark output against its definition
	 */
	async grade(
		benchmark: BenchmarkDefinition,
		output: string,
		tokensUsed: number,
		duration: number,
	): Promise<BenchmarkResult> {
		const checkResults: CheckResult[] = [];
		const errors: string[] = [];
		const warnings: string[] = [];

		// Run all rubric checks
		const rubric = benchmark.rubric;

		// Correctness checks
		for (const check of rubric.correctness.checks) {
			const result = await this.runCheck(check, output, benchmark);
			checkResults.push(result);
			if (!result.passed) {
				errors.push(`Correctness: ${check.name} failed - ${result.details}`);
			}
		}

		// Code quality checks
		for (const check of rubric.codeQuality.checks) {
			const result = await this.runCheck(check, output, benchmark);
			checkResults.push(result);
			if (!result.passed && result.score < result.maxScore * 0.5) {
				warnings.push(`Quality: ${check.name} - ${result.details}`);
			}
		}

		// Efficiency checks
		for (const check of rubric.efficiency.checks) {
			const result = await this.runCheck(check, output, benchmark);
			checkResults.push(result);
		}

		// Best practices checks
		for (const check of rubric.bestPractices.checks) {
			const result = await this.runCheck(check, output, benchmark);
			checkResults.push(result);
		}

		// Calculate scores
		const scores = this.calculateScores(rubric, checkResults);

		// Token efficiency
		const tokenEfficiency =
			tokensUsed > 0 ? benchmark.expectedTokens / tokensUsed : 0;

		return {
			benchmarkId: benchmark.id,
			timestamp: new Date().toISOString(),
			model: process.env.MODEL || "unknown",
			provider: process.env.PROVIDER || "unknown",
			scores,
			tokens: {
				actual: tokensUsed,
				expected: benchmark.expectedTokens,
				efficiency: tokenEfficiency,
			},
			timing: {
				startTime: Date.now() - duration,
				endTime: Date.now(),
				duration,
				withinLimit: duration <= benchmark.timeLimit,
			},
			output,
			errors,
			warnings,
			checkResults,
		};
	}

	/**
	 * Run a single rubric check
	 */
	private async runCheck(
		check: RubricCheck,
		output: string,
		benchmark: BenchmarkDefinition,
	): Promise<CheckResult> {
		switch (check.validator) {
			case "regex":
				return this.runRegexCheck(check, output);
			case "ast":
				return this.runAstCheck(check, output);
			case "execution":
				return await this.runExecutionCheck(check, output, benchmark);
			case "llm":
				return await this.runLLMCheck(check, output, benchmark);
			case "manual":
			default:
				return this.createManualCheckResult(check);
		}
	}

	/**
	 * Regex-based validation
	 */
	private runRegexCheck(check: RubricCheck, output: string): CheckResult {
		const config = check.config as {
			pattern: string;
			flags?: string;
			shouldMatch?: boolean;
			countMin?: number;
			countMax?: number;
		};

		const regex = new RegExp(config.pattern, config.flags || "gm");
		const matches = output.match(regex);
		const matchCount = matches?.length || 0;
		const shouldMatch = config.shouldMatch !== false;

		let passed = false;
		let details = "";

		if (config.countMin !== undefined || config.countMax !== undefined) {
			const min = config.countMin ?? 0;
			const max = config.countMax ?? Infinity;
			passed = matchCount >= min && matchCount <= max;
			details = `Found ${matchCount} matches (expected ${min}-${max})`;
		} else {
			passed = shouldMatch ? matchCount > 0 : matchCount === 0;
			details = shouldMatch
				? matchCount > 0
					? `Pattern matched ${matchCount} times`
					: "Pattern not found"
				: matchCount === 0
					? "Pattern correctly absent"
					: `Pattern found ${matchCount} times (should be absent)`;
		}

		return {
			checkName: check.name,
			passed,
			score: passed ? check.points : 0,
			maxScore: check.points,
			details,
		};
	}

	/**
	 * AST-based validation (syntax, structure)
	 */
	private runAstCheck(check: RubricCheck, output: string): CheckResult {
		const config = check.config as {
			language: string;
			checkType:
				| "syntax"
				| "hasFunction"
				| "hasClass"
				| "hasExport"
				| "noConsoleLog";
			target?: string;
		};

		// Basic syntax check using eval safety
		if (config.checkType === "syntax") {
			try {
				// Try to parse as JavaScript/TypeScript
				new Function(output.replace(/import|export/g, "//"));
				return {
					checkName: check.name,
					passed: true,
					score: check.points,
					maxScore: check.points,
					details: "Syntax is valid",
				};
			} catch (e) {
				return {
					checkName: check.name,
					passed: false,
					score: 0,
					maxScore: check.points,
					details: `Syntax error: ${(e as Error).message}`,
				};
			}
		}

		// Check for specific constructs
		const patterns: Record<string, RegExp> = {
			hasFunction: /function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\(/,
			hasClass: /class\s+\w+/,
			hasExport:
				/export\s+(?:default\s+)?(?:const|function|class|interface|type)/,
			noConsoleLog: /console\.log/g,
		};

		const pattern = patterns[config.checkType];
		if (!pattern) {
			return {
				checkName: check.name,
				passed: false,
				score: 0,
				maxScore: check.points,
				details: `Unknown AST check type: ${config.checkType}`,
			};
		}

		const matches = output.match(pattern);
		const isNegativeCheck = config.checkType.startsWith("no");
		const passed = isNegativeCheck ? !matches : !!matches;

		return {
			checkName: check.name,
			passed,
			score: passed ? check.points : 0,
			maxScore: check.points,
			details: passed
				? `${config.checkType} check passed`
				: `${config.checkType} check failed`,
		};
	}

	/**
	 * Execution-based validation (run the code)
	 */
	private async runExecutionCheck(
		check: RubricCheck,
		output: string,
		benchmark: BenchmarkDefinition,
	): Promise<CheckResult> {
		const config = check.config as {
			testCommand?: string;
			expectedOutput?: string;
			expectedExitCode?: number;
			timeout?: number;
		};

		try {
			// Write output to temp file
			const tempFile = path.join(this.workDir, `temp_${benchmark.id}.ts`);
			fs.writeFileSync(tempFile, output);

			// Run test command or just try to execute
			const command = config.testCommand || `bun run ${tempFile}`;
			const result = await this.executeCommand(
				command,
				config.timeout || 10000,
			);

			// Clean up
			fs.unlinkSync(tempFile);

			const expectedExitCode = config.expectedExitCode ?? 0;
			const exitCodeMatch = result.exitCode === expectedExitCode;

			let outputMatch = true;
			if (config.expectedOutput) {
				outputMatch = result.output.includes(config.expectedOutput);
			}

			const passed = exitCodeMatch && outputMatch;

			return {
				checkName: check.name,
				passed,
				score: passed ? check.points : 0,
				maxScore: check.points,
				details: passed
					? "Execution successful"
					: `Exit code: ${result.exitCode}, Output match: ${outputMatch}`,
			};
		} catch (e) {
			return {
				checkName: check.name,
				passed: false,
				score: 0,
				maxScore: check.points,
				details: `Execution error: ${(e as Error).message}`,
			};
		}
	}

	/**
	 * LLM-based validation (for subjective quality checks)
	 */
	private async runLLMCheck(
		check: RubricCheck,
		output: string,
		benchmark: BenchmarkDefinition,
	): Promise<CheckResult> {
		const config = check.config as {
			prompt: string;
			scoreThreshold: number;
		};

		// For now, use heuristics instead of actual LLM call
		// In production, this would call the LLM to evaluate
		const heuristicScore = this.heuristicQualityScore(output, config.prompt);
		const passed = heuristicScore >= config.scoreThreshold;

		return {
			checkName: check.name,
			passed,
			score: Math.round((heuristicScore / 100) * check.points),
			maxScore: check.points,
			details: `Heuristic score: ${heuristicScore}/100`,
		};
	}

	/**
	 * Heuristic quality scoring
	 */
	private heuristicQualityScore(output: string, criteria: string): number {
		let score = 50; // Base score

		// Length check
		if (output.length < 50) score -= 20;
		if (output.length > 100) score += 10;

		// Has comments
		if (output.includes("//") || output.includes("/*")) score += 10;

		// Has proper indentation
		if (output.includes("  ") || output.includes("\t")) score += 5;

		// Has type annotations
		if (output.includes(": ") && output.includes("=>")) score += 10;

		// No obvious issues
		if (!output.includes("TODO")) score += 5;
		if (!output.includes("FIXME")) score += 5;
		if (!output.includes("any")) score += 5;

		return Math.max(0, Math.min(100, score));
	}

	/**
	 * Create placeholder for manual checks
	 */
	private createManualCheckResult(check: RubricCheck): CheckResult {
		return {
			checkName: check.name,
			passed: true,
			score: check.points * 0.7, // Default to 70% for manual
			maxScore: check.points,
			details: "Manual review required",
		};
	}

	/**
	 * Execute a shell command
	 */
	private async executeCommand(
		command: string,
		timeout: number,
	): Promise<ExecutionResult> {
		const { spawn } = await import("child_process");

		return new Promise((resolve) => {
			const startTime = Date.now();
			const proc = spawn("sh", ["-c", command], {
				timeout,
				cwd: this.workDir,
			});

			let stdout = "";
			let stderr = "";

			proc.stdout?.on("data", (data) => {
				stdout += data.toString();
			});

			proc.stderr?.on("data", (data) => {
				stderr += data.toString();
			});

			proc.on("close", (code) => {
				resolve({
					success: code === 0,
					output: stdout,
					stderr,
					exitCode: code ?? 1,
					duration: Date.now() - startTime,
				});
			});

			proc.on("error", (err) => {
				resolve({
					success: false,
					output: "",
					stderr: err.message,
					exitCode: 1,
					duration: Date.now() - startTime,
				});
			});
		});
	}

	/**
	 * Calculate category scores from check results
	 */
	private calculateScores(
		rubric: BenchmarkDefinition["rubric"],
		checkResults: CheckResult[],
	): BenchmarkResult["scores"] {
		const getScore = (checks: RubricCheck[]): number => {
			const checkNames = new Set(checks.map((c) => c.name));
			const relevant = checkResults.filter((r) => checkNames.has(r.checkName));
			if (relevant.length === 0) return 100;

			const totalScore = relevant.reduce((sum, r) => sum + r.score, 0);
			const maxScore = relevant.reduce((sum, r) => sum + r.maxScore, 0);
			return maxScore > 0 ? (totalScore / maxScore) * 100 : 100;
		};

		const correctness = getScore(rubric.correctness.checks);
		const codeQuality = getScore(rubric.codeQuality.checks);
		const efficiency = getScore(rubric.efficiency.checks);
		const bestPractices = getScore(rubric.bestPractices.checks);

		// Weighted overall score
		const overall =
			correctness * rubric.correctness.weight +
			codeQuality * rubric.codeQuality.weight +
			efficiency * rubric.efficiency.weight +
			bestPractices * rubric.bestPractices.weight;

		return {
			correctness: Math.round(correctness),
			codeQuality: Math.round(codeQuality),
			efficiency: Math.round(efficiency),
			bestPractices: Math.round(bestPractices),
			overall: Math.round(overall),
		};
	}
}

/**
 * Create standard rubric for common benchmark types
 */
export function createStandardRubric(
	type: "file-edit" | "bug-fix" | "feature" | "test" | "review" | "docs",
): BenchmarkDefinition["rubric"] {
	const baseRubric: BenchmarkDefinition["rubric"] = {
		correctness: {
			weight: 0.4,
			checks: [
				{
					name: "syntax-valid",
					description: "Code has valid syntax",
					points: 20,
					validator: "ast",
					config: { language: "typescript", checkType: "syntax" },
				},
			],
		},
		codeQuality: {
			weight: 0.25,
			checks: [
				{
					name: "has-comments",
					description: "Code includes helpful comments",
					points: 10,
					validator: "regex",
					config: { pattern: "//|/\\*", countMin: 1 },
				},
				{
					name: "no-console-logs",
					description: "No debug console.log statements",
					points: 10,
					validator: "ast",
					config: { language: "typescript", checkType: "noConsoleLog" },
				},
			],
		},
		efficiency: {
			weight: 0.2,
			checks: [
				{
					name: "reasonable-length",
					description: "Code is not unnecessarily verbose",
					points: 15,
					validator: "llm",
					config: { prompt: "Is this code concise?", scoreThreshold: 60 },
				},
			],
		},
		bestPractices: {
			weight: 0.15,
			checks: [
				{
					name: "uses-types",
					description: "Uses TypeScript types appropriately",
					points: 10,
					validator: "regex",
					config: { pattern: ":\\s*\\w+|<\\w+>", countMin: 1 },
				},
			],
		},
	};

	// Add type-specific checks
	switch (type) {
		case "bug-fix":
			baseRubric.correctness.checks.push({
				name: "fixes-bug",
				description: "The bug is actually fixed",
				points: 30,
				validator: "execution",
				config: { expectedExitCode: 0 },
			});
			break;

		case "test":
			baseRubric.correctness.checks.push(
				{
					name: "has-test-function",
					description: "Contains test functions",
					points: 20,
					validator: "regex",
					config: {
						pattern: "test\\(|it\\(|describe\\(|expect\\(",
						countMin: 1,
					},
				},
				{
					name: "tests-pass",
					description: "All tests pass",
					points: 30,
					validator: "execution",
					config: { testCommand: "bun test", expectedExitCode: 0 },
				},
			);
			break;

		case "feature":
			baseRubric.correctness.checks.push({
				name: "has-export",
				description: "Feature is properly exported",
				points: 15,
				validator: "ast",
				config: { language: "typescript", checkType: "hasExport" },
			});
			break;

		case "docs":
			baseRubric.correctness.checks.push(
				{
					name: "has-jsdoc",
					description: "Includes JSDoc comments",
					points: 20,
					validator: "regex",
					config: { pattern: "/\\*\\*[\\s\\S]*?\\*/", countMin: 1 },
				},
				{
					name: "has-param-docs",
					description: "Documents parameters",
					points: 15,
					validator: "regex",
					config: { pattern: "@param", countMin: 1 },
				},
			);
			break;
	}

	return baseRubric;
}
