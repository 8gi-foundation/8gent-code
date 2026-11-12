/**
 * Universal CLI Agent Spawner
 *
 * Spawns background agents using different runtimes:
 * - "8gent": spawns an internal 8gent Agent instance (default)
 * - "claude": spawns `claude --print --dangerously-skip-permissions "<task>"` as a subprocess
 * - "shell": spawns `sh -c "<task>"` for simple commands
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { killProcessTree, shellInvocation } from "../core/shell";

// ============================================
// Types
// ============================================

export type AgentRuntime = "8gent" | "claude" | "shell";

export interface CLIAgentOptions {
	workingDirectory?: string;
	timeout?: number; // ms, default 5 minutes
	model?: string; // only used for 8gent runtime
	env?: Record<string, string>;
}

export interface CLIAgentResult {
	runtime: AgentRuntime;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	durationMs: number;
	workingDirectory: string;
}

export interface RunningCLIAgent {
	id: string;
	runtime: AgentRuntime;
	task: string;
	process: ChildProcess | null; // null for 8gent (uses Agent class)
	startedAt: Date;
	completedAt?: Date;
	result?: CLIAgentResult;
	promise: Promise<CLIAgentResult>;
	workingDirectory: string;
}

// ============================================
// Registry for CLI-spawned agents
// ============================================

const cliAgents = new Map<string, RunningCLIAgent>();

// Detached children lead their own process group, so they no longer die with
// our terminal's Ctrl+C / hangup. Track every live child and kill its group
// when this process goes away, so none outlives the person who stopped us.
const liveChildren = new Set<ChildProcess>();
let exitCleanupInstalled = false;

function killAllLiveChildren(): void {
	for (const child of liveChildren) killProcessTree(child.pid, "SIGKILL");
	liveChildren.clear();
}

function installExitCleanup(): void {
	if (exitCleanupInstalled) return;
	exitCleanupInstalled = true;
	process.on("exit", killAllLiveChildren);
	if (process.platform === "win32") return;
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		const handler = () => {
			killAllLiveChildren();
			process.removeListener(sig, handler);
			// Re-raise so the default exit (or any other listener) still happens.
			process.kill(process.pid, sig);
		};
		process.on(sig, handler);
	}
}
let cliIdCounter = 0;

function generateCLIId(): string {
	cliIdCounter++;
	return `cli-${Date.now()}-${cliIdCounter}`;
}

// ============================================
// Core Spawner
// ============================================

/**
 * Spawn a CLI agent with the given runtime.
 *
 * - "claude": runs `claude --print --dangerously-skip-permissions "<task>"`
 * - "shell": runs the task through the platform shell (`sh -c`, or cmd.exe on Windows)
 * - "8gent": delegates to AgentPool (returns null — handled separately)
 */
export function spawnCLIAgent(
	runtime: AgentRuntime,
	task: string,
	options: CLIAgentOptions = {},
): RunningCLIAgent {
	const id = generateCLIId();
	const workingDirectory = options.workingDirectory || process.cwd();
	const timeout = options.timeout || 5 * 60 * 1000; // 5 minutes

	// Create a temp working directory for isolation
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `8gent-cli-${runtime}-`));

	// Determine the actual cwd: use the project's working directory, not tmp
	// (tmp is available for scratch if needed, but commands run in project context)
	const cwd = workingDirectory;

	let cmd: string;
	let args: string[];
	let windowsVerbatimArguments = false;

	switch (runtime) {
		case "claude":
			cmd = "claude";
			args = ["--print", "--dangerously-skip-permissions", task];
			break;
		case "shell":
			({ file: cmd, args, windowsVerbatimArguments } = shellInvocation(task));
			break;
		default:
			throw new Error(`Runtime "${runtime}" should be handled by AgentPool, not spawnCLIAgent`);
	}

	const startedAt = new Date();
	let stdout = "";
	let stderr = "";
	let timedOut = false;

	const proc = spawn(cmd, args, {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...(options.env || {}) },
		windowsHide: true,
		windowsVerbatimArguments,
		// POSIX: make the child its own process-group leader so a timeout or cancel
		// can signal the whole group (killProcessTree uses the negative pid, and
		// falls back to the direct child). Windows has no groups; taskkill /T walks
		// the tree there, so the current behaviour stays.
		detached: process.platform !== "win32",
	});
	liveChildren.add(proc);
	installExitCleanup();

	const promise = new Promise<CLIAgentResult>((resolve) => {
		let settled = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;

		const timeoutHandle = setTimeout(() => {
			if (settled) return;
			settled = true;
			timedOut = true;
			killProcessTree(proc.pid, "SIGTERM");
			// Give it 5s to die gracefully, then SIGKILL
			killTimer = setTimeout(() => killProcessTree(proc.pid, "SIGKILL"), 5000);

			const result: CLIAgentResult = {
				runtime,
				exitCode: null,
				stdout,
				stderr: `${stderr}\n[TIMEOUT after ${timeout / 1000}s]`,
				timedOut: true,
				durationMs: Date.now() - startedAt.getTime(),
				workingDirectory: cwd,
			};

			const agent = cliAgents.get(id);
			if (agent) {
				agent.completedAt = new Date();
				agent.result = result;
			}

			// Clean up temp dir
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {}

			resolve(result);
		}, timeout);

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			liveChildren.delete(proc);
			// The child is reaped: its pid may be reused, so never SIGKILL it later.
			if (killTimer) clearTimeout(killTimer);
			if (settled) return;
			settled = true;
			clearTimeout(timeoutHandle);

			const result: CLIAgentResult = {
				runtime,
				exitCode: code,
				stdout,
				stderr,
				timedOut: false,
				durationMs: Date.now() - startedAt.getTime(),
				workingDirectory: cwd,
			};

			const agent = cliAgents.get(id);
			if (agent) {
				agent.completedAt = new Date();
				agent.result = result;
			}

			// Clean up temp dir
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {}

			resolve(result);
		});

		proc.on("error", (err) => {
			liveChildren.delete(proc);
			if (settled) return;
			settled = true;
			clearTimeout(timeoutHandle);

			const result: CLIAgentResult = {
				runtime,
				exitCode: -1,
				stdout,
				stderr: `${stderr}\n[SPAWN ERROR] ${err.message}`,
				timedOut: false,
				durationMs: Date.now() - startedAt.getTime(),
				workingDirectory: cwd,
			};

			const agent = cliAgents.get(id);
			if (agent) {
				agent.completedAt = new Date();
				agent.result = result;
			}

			// Clean up temp dir
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {}

			resolve(result);
		});
	});

	const runningAgent: RunningCLIAgent = {
		id,
		runtime,
		task,
		process: proc,
		startedAt,
		promise,
		workingDirectory: cwd,
	};

	cliAgents.set(id, runningAgent);
	return runningAgent;
}

// ============================================
// Registry accessors
// ============================================

export function getCLIAgent(id: string): RunningCLIAgent | undefined {
	return cliAgents.get(id);
}

export function listCLIAgents(): RunningCLIAgent[] {
	return Array.from(cliAgents.values());
}

export function getCLIAgentStatus(id: string): {
	id: string;
	runtime: AgentRuntime;
	task: string;
	status: "running" | "completed" | "failed" | "timed_out";
	elapsed: string;
	result?: CLIAgentResult;
} | null {
	const agent = cliAgents.get(id);
	if (!agent) return null;

	const now = agent.completedAt || new Date();
	const elapsed = `${((now.getTime() - agent.startedAt.getTime()) / 1000).toFixed(1)}s`;

	let status: "running" | "completed" | "failed" | "timed_out";
	if (!agent.completedAt) {
		status = "running";
	} else if (agent.result?.timedOut) {
		status = "timed_out";
	} else if (agent.result?.exitCode === 0) {
		status = "completed";
	} else {
		status = "failed";
	}

	return {
		id: agent.id,
		runtime: agent.runtime,
		task: agent.task.slice(0, 200),
		status,
		elapsed: agent.completedAt ? elapsed : `${elapsed} (running)`,
		result: agent.result,
	};
}

export function clearFinishedCLIAgents(): number {
	let cleared = 0;
	for (const [id, agent] of cliAgents) {
		if (agent.completedAt) {
			cliAgents.delete(id);
			cleared++;
		}
	}
	return cleared;
}

export function resetCLIAgents(): void {
	// Kill any still-running processes
	for (const agent of cliAgents.values()) {
		if (!agent.completedAt && agent.process) {
			killProcessTree(agent.process.pid, "SIGTERM");
		}
	}
	cliAgents.clear();
	cliIdCounter = 0;
}
