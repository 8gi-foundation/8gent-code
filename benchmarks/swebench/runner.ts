#!/usr/bin/env bun
/**
 * SWE-bench Evaluation Runner
 * Clone repo at base_commit, run agent, verify patch against gold tests.
 * Docker isolation deferred - uses temp dirs with git for now.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { SWEBenchTask } from "./loader";

export interface TaskResult {
	task_id: string;
	repo: string;
	passed: boolean;
	agent_patch: string;
	duration_ms: number;
	error?: string;
}

interface RunnerConfig {
	timeout_ms: number;
	model: string;
	agent_cmd: string;
}

const DEFAULT_CONFIG: RunnerConfig = {
	timeout_ms: 5 * 60 * 1000,
	model: "qwen3.5:latest",
	agent_cmd: "bun run bin/8gent.ts",
};

async function run(
	cmd: string,
	args: string[],
	cwd: string,
	timeout_ms = 120_000,
): Promise<string> {
	const proc = Bun.spawn([cmd, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill(), timeout_ms);
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	clearTimeout(timer);
	if (exitCode !== 0)
		throw new Error(`${cmd} ${args[0]} failed (${exitCode}): ${stderr.slice(0, 300)}`);
	return stdout;
}

async function setupRepo(task: SWEBenchTask, workDir: string): Promise<string> {
	const repoDir = path.join(workDir, task.instance_id.replace(/[/:]/g, "_"));
	fs.mkdirSync(repoDir, { recursive: true });
	const url = `https://github.com/${task.repo}.git`;
	await run("git", ["init"], repoDir);
	await run("git", ["remote", "add", "origin", url], repoDir);
	await run("git", ["fetch", "--depth", "1", "origin", task.base_commit], repoDir);
	await run("git", ["checkout", "FETCH_HEAD"], repoDir);
	return repoDir;
}

function extractPatch(output: string): string {
	const diffMatch = output.match(/```(?:diff|patch)?\n([\s\S]*?)```/);
	if (diffMatch) return diffMatch[1].trim();
	const lines = output.split("\n");
	const diffLines: string[] = [];
	let inDiff = false;
	for (const line of lines) {
		if (line.startsWith("---") || line.startsWith("diff --git")) inDiff = true;
		if (inDiff) diffLines.push(line);
	}
	return diffLines.length > 0 ? diffLines.join("\n") : output;
}

async function runAgent(
	task: SWEBenchTask,
	repoDir: string,
	config: RunnerConfig,
): Promise<string> {
	const prompt = [
		`You are working in the repository: ${task.repo}`,
		`\nProblem:\n${task.problem_statement}`,
		task.hints_text ? `\nHints:\n${task.hints_text}` : "",
		"\nFix the issue. Output ONLY a unified diff patch.",
	]
		.filter(Boolean)
		.join("\n");

	const promptFile = path.join(repoDir, ".swebench-prompt.txt");
	fs.writeFileSync(promptFile, prompt);
	try {
		const proc = Bun.spawn(["sh", "-c", `cat ${promptFile} | ${config.agent_cmd} chat --json`], {
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				OLLAMA_MODEL: config.model,
				EIGHT_HEADLESS: "1",
			},
		});
		const timer = setTimeout(() => proc.kill(), config.timeout_ms);
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		clearTimeout(timer);
		return extractPatch(stdout);
	} finally {
		if (fs.existsSync(promptFile)) fs.unlinkSync(promptFile);
	}
}

async function verifyPatch(
	task: SWEBenchTask,
	repoDir: string,
	agentPatch: string,
): Promise<boolean> {
	try {
		// Apply agent patch
		const patchFile = path.join(repoDir, ".agent-patch.diff");
		fs.writeFileSync(patchFile, agentPatch);
		try {
			await run("git", ["apply", "--check", patchFile], repoDir);
			await run("git", ["apply", patchFile], repoDir);
		} catch {
			return false;
		}

		// Apply gold test patch
		const testFile = path.join(repoDir, ".test-patch.diff");
		fs.writeFileSync(testFile, task.test_patch);
		try {
			await run("git", ["apply", testFile], repoDir);
		} catch {
			return false;
		}

		// Parse FAIL_TO_PASS tests
		let failToPass: string[] = [];
		try {
			failToPass = JSON.parse(task.FAIL_TO_PASS);
		} catch {
			failToPass = task.FAIL_TO_PASS ? task.FAIL_TO_PASS.split(",").map((s) => s.trim()) : [];
		}
		if (failToPass.length === 0) return true;

		// Run tests (best effort - full SWE-bench uses Docker per-repo)
		try {
			await run("python", ["-m", "pytest", ...failToPass, "--tb=short", "-q"], repoDir, 60_000);
			return true;
		} catch {
			return false;
		}
	} catch {
		return false;
	}
}

export async function runTask(
	task: SWEBenchTask,
	workDir: string,
	config: Partial<RunnerConfig> = {},
): Promise<TaskResult> {
	const cfg = { ...DEFAULT_CONFIG, ...config };
	const start = Date.now();
	try {
		const repoDir = await setupRepo(task, workDir);
		const agentPatch = await runAgent(task, repoDir, cfg);
		const passed = await verifyPatch(task, repoDir, agentPatch);
		return {
			task_id: task.instance_id,
			repo: task.repo,
			passed,
			agent_patch: agentPatch,
			duration_ms: Date.now() - start,
		};
	} catch (err) {
		return {
			task_id: task.instance_id,
			repo: task.repo,
			passed: false,
			agent_patch: "",
			duration_ms: Date.now() - start,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export async function runAllTasks(
	tasks: SWEBenchTask[],
	workDir: string,
	config: Partial<RunnerConfig> = {},
	onProgress?: (index: number, total: number, result: TaskResult) => void,
): Promise<TaskResult[]> {
	const results: TaskResult[] = [];
	for (let i = 0; i < tasks.length; i++) {
		const result = await runTask(tasks[i], workDir, config);
		results.push(result);
		if (onProgress) onProgress(i + 1, tasks.length, result);
	}
	return results;
}
