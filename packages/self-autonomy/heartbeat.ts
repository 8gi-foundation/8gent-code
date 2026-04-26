/**
 * 8gent Code - Heartbeat Agents
 *
 * Lightweight background agents that run on intervals.
 * Deterministic, low-context, just heartbeats.
 */

import { AutoGit, SelfHeal, SessionMemory, SelfAutonomy } from "./index";
import { EventEmitter } from "events";

// ============================================
// Types
// ============================================

export interface HeartbeatConfig {
	/** Interval in ms for git heartbeat */
	gitInterval: number;
	/** Interval in ms for self-heal check */
	healInterval: number;
	/** Interval in ms for memory sync */
	memoryInterval: number;
	/** Interval in ms for self-modify check */
	modifyInterval: number;
	/** Working directory */
	workingDirectory: string;
	/** Verbose logging */
	verbose: boolean;
}

export interface HeartbeatStatus {
	git: {
		running: boolean;
		lastRun: Date | null;
		uncommittedFiles: number;
		currentBranch: string;
	};
	heal: {
		running: boolean;
		lastRun: Date | null;
		errorsTracked: number;
		solutionsKnown: number;
	};
	memory: {
		running: boolean;
		lastRun: Date | null;
		contextAge: number; // seconds
	};
	modify: {
		running: boolean;
		lastRun: Date | null;
		pendingFixes: number;
	};
}

export type HeartbeatEvent =
	| "git:commit"
	| "git:branch"
	| "git:stash"
	| "heal:retry"
	| "heal:recover"
	| "memory:save"
	| "memory:prune"
	| "modify:attempt"
	| "modify:success"
	| "modify:fail";

// ============================================
// Heartbeat Agents
// ============================================

export class HeartbeatAgents extends EventEmitter {
	private config: HeartbeatConfig;
	private autonomy: SelfAutonomy;

	private gitTimer: NodeJS.Timeout | null = null;
	private healTimer: NodeJS.Timeout | null = null;
	private memoryTimer: NodeJS.Timeout | null = null;
	private modifyTimer: NodeJS.Timeout | null = null;

	private status: HeartbeatStatus;
	private running: boolean = false;

	// Track errors for self-heal
	private recentErrors: Array<{ error: string; timestamp: number }> = [];
	private pendingModifications: Array<{ file: string; reason: string }> = [];

	constructor(config: Partial<HeartbeatConfig> = {}) {
		super();

		this.config = {
			gitInterval: config.gitInterval ?? 5000, // 5s - check for uncommitted changes
			healInterval: config.healInterval ?? 3000, // 3s - check for error patterns
			memoryInterval: config.memoryInterval ?? 10000, // 10s - sync memory
			modifyInterval: config.modifyInterval ?? 15000, // 15s - check for self-modify needs
			workingDirectory: config.workingDirectory ?? process.cwd(),
			verbose: config.verbose ?? false,
		};

		this.autonomy = new SelfAutonomy({
			workingDirectory: this.config.workingDirectory,
			verbose: this.config.verbose,
		});

		this.status = {
			git: {
				running: false,
				lastRun: null,
				uncommittedFiles: 0,
				currentBranch: "main",
			},
			heal: {
				running: false,
				lastRun: null,
				errorsTracked: 0,
				solutionsKnown: 0,
			},
			memory: { running: false, lastRun: null, contextAge: 0 },
			modify: { running: false, lastRun: null, pendingFixes: 0 },
		};
	}

	private log(agent: string, message: string): void {
		if (this.config.verbose) {
			console.log(`[8gent:${agent}] ${message}`);
		}
		this.emit("log", { agent, message, timestamp: new Date() });
	}

	// ============================================
	// Git Heartbeat
	// ============================================

	private async gitHeartbeat(): Promise<void> {
		if (!this.autonomy.git.isGitRepo()) return;

		try {
			const state = this.autonomy.git.getState();
			this.status.git.currentBranch = state.branch;
			this.status.git.uncommittedFiles = state.uncommittedFiles.length;
			this.status.git.lastRun = new Date();

			// Auto-commit if there are changes and we're on an 8gent branch
			if (
				state.uncommittedFiles.length > 0 &&
				state.branch.startsWith("8gent/")
			) {
				// Group files by type
				const tsFiles = state.uncommittedFiles.filter(
					(f) => f.endsWith(".ts") || f.endsWith(".tsx"),
				);
				const testFiles = state.uncommittedFiles.filter(
					(f) => f.includes(".test.") || f.includes(".spec."),
				);
				const otherFiles = state.uncommittedFiles.filter(
					(f) =>
						!f.endsWith(".ts") &&
						!f.endsWith(".tsx") &&
						!f.includes(".test.") &&
						!f.includes(".spec."),
				);

				// Commit by category
				if (tsFiles.length > 0) {
					const scope = this.inferScope(tsFiles);
					this.autonomy.git.commit(tsFiles, "feat", scope, "work in progress");
					this.emit("git:commit", { files: tsFiles, type: "feat" });
					this.log("git", `Committed ${tsFiles.length} source files`);
				}

				if (testFiles.length > 0) {
					this.autonomy.git.commit(testFiles, "test", "tests", "update tests");
					this.emit("git:commit", { files: testFiles, type: "test" });
					this.log("git", `Committed ${testFiles.length} test files`);
				}

				if (otherFiles.length > 0) {
					this.autonomy.git.commit(otherFiles, "chore", "misc", "update files");
					this.emit("git:commit", { files: otherFiles, type: "chore" });
				}
			}
		} catch (err) {
			// Silently handle git errors
		}
	}

	private inferScope(files: string[]): string {
		// Infer scope from common path
		if (files.length === 0) return "app";

		const parts = files[0].split("/");
		if (parts.length > 1) {
			if (parts[0] === "packages" && parts.length > 2) return parts[1];
			if (parts[0] === "src" && parts.length > 1) return parts[1];
			if (parts[0] === "apps" && parts.length > 2) return parts[1];
		}
		return "app";
	}

	// ============================================
	// Self-Heal Heartbeat
	// ============================================

	private async healHeartbeat(): Promise<void> {
		try {
			this.status.heal.lastRun = new Date();

			// Clean old errors (older than 5 minutes)
			const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
			this.recentErrors = this.recentErrors.filter(
				(e) => e.timestamp > fiveMinutesAgo,
			);
			this.status.heal.errorsTracked = this.recentErrors.length;

			// Count error patterns
			const errorCounts: Record<string, number> = {};
			for (const { error } of this.recentErrors) {
				const pattern = this.normalizeError(error);
				errorCounts[pattern] = (errorCounts[pattern] || 0) + 1;
			}

			// If any error occurred 3+ times, queue for self-modification
			for (const [pattern, count] of Object.entries(errorCounts)) {
				if (count >= 3) {
					const solution = this.autonomy.heal.getKnownSolution(pattern);
					if (!solution) {
						// Queue for self-modification
						this.pendingModifications.push({
							file: "unknown",
							reason: `Error pattern '${pattern}' occurred ${count} times`,
						});
						this.log("heal", `Queued fix for error: ${pattern}`);
					}
				}
			}
		} catch (err) {
			// Silently handle
		}
	}

	private normalizeError(message: string): string {
		return message
			.toLowerCase()
			.replace(/[0-9]+/g, "N")
			.replace(/\/[^\s]+/g, "/PATH")
			.slice(0, 50);
	}

	/**
	 * Report an error to the heal agent
	 */
	reportError(error: string): void {
		this.recentErrors.push({ error, timestamp: Date.now() });
		this.emit("error:reported", { error });
	}

	// ============================================
	// Memory Heartbeat
	// ============================================

	private async memoryHeartbeat(): Promise<void> {
		try {
			this.status.memory.lastRun = new Date();

			// Get current working context
			const context = this.autonomy.memory.getWorkingContext();
			if (context) {
				const started = new Date(context.started);
				this.status.memory.contextAge = Math.floor(
					(Date.now() - started.getTime()) / 1000,
				);
			}

			// Auto-save working context if agent has active state
			// (This would be called from the main agent with actual context)
		} catch (err) {
			// Silently handle
		}
	}

	/**
	 * Update working context
	 */
	updateContext(
		updates: Partial<{
			activeFiles: string[];
			currentTask: string;
			notes: string;
		}>,
	): void {
		const existing = this.autonomy.memory.getWorkingContext();
		if (existing) {
			this.autonomy.memory.saveWorkingContext({
				...existing,
				...updates,
			});
			this.emit("memory:save", { updates });
		}
	}

	// ============================================
	// Self-Modify Heartbeat
	// ============================================

	private async modifyHeartbeat(): Promise<void> {
		try {
			this.status.modify.lastRun = new Date();
			this.status.modify.pendingFixes = this.pendingModifications.length;

			// Process one pending modification at a time
			if (this.pendingModifications.length > 0) {
				const modification = this.pendingModifications[0];

				// Only attempt if we're on main or an 8gent branch
				const state = this.autonomy.git.getState();
				if (state.branch === "main" || state.branch.startsWith("8gent/")) {
					this.emit("modify:attempt", { modification });
					this.log("modify", `Attempting fix: ${modification.reason}`);

					// The actual modification would be done by the main agent
					// This heartbeat just tracks and triggers
				}
			}
		} catch (err) {
			// Silently handle
		}
	}

	/**
	 * Queue a modification
	 */
	queueModification(file: string, reason: string): void {
		this.pendingModifications.push({ file, reason });
		this.status.modify.pendingFixes = this.pendingModifications.length;
	}

	/**
	 * Mark modification as complete
	 */
	completeModification(success: boolean): void {
		if (this.pendingModifications.length > 0) {
			const mod = this.pendingModifications.shift()!;
			this.emit(success ? "modify:success" : "modify:fail", {
				modification: mod,
			});
			this.status.modify.pendingFixes = this.pendingModifications.length;
		}
	}

	// ============================================
	// Control
	// ============================================

	/**
	 * Start all heartbeat agents
	 */
	start(): void {
		if (this.running) return;
		this.running = true;

		this.gitTimer = setInterval(
			() => this.gitHeartbeat(),
			this.config.gitInterval,
		);
		this.healTimer = setInterval(
			() => this.healHeartbeat(),
			this.config.healInterval,
		);
		this.memoryTimer = setInterval(
			() => this.memoryHeartbeat(),
			this.config.memoryInterval,
		);
		this.modifyTimer = setInterval(
			() => this.modifyHeartbeat(),
			this.config.modifyInterval,
		);

		this.status.git.running = true;
		this.status.heal.running = true;
		this.status.memory.running = true;
		this.status.modify.running = true;

		this.log("heartbeat", "All agents started");
		this.emit("started");
	}

	/**
	 * Stop all heartbeat agents
	 */
	stop(): void {
		if (!this.running) return;
		this.running = false;

		if (this.gitTimer) clearInterval(this.gitTimer);
		if (this.healTimer) clearInterval(this.healTimer);
		if (this.memoryTimer) clearInterval(this.memoryTimer);
		if (this.modifyTimer) clearInterval(this.modifyTimer);

		this.gitTimer = null;
		this.healTimer = null;
		this.memoryTimer = null;
		this.modifyTimer = null;

		this.status.git.running = false;
		this.status.heal.running = false;
		this.status.memory.running = false;
		this.status.modify.running = false;

		this.log("heartbeat", "All agents stopped");
		this.emit("stopped");
	}

	/**
	 * Get current status of all agents
	 */
	getStatus(): HeartbeatStatus {
		return { ...this.status };
	}

	/**
	 * Get the underlying autonomy instance
	 */
	getAutonomy(): SelfAutonomy {
		return this.autonomy;
	}

	/**
	 * Check if agents are running
	 */
	isRunning(): boolean {
		return this.running;
	}

	/**
	 * Start a task (creates branch, updates context)
	 */
	startTask(
		description: string,
		type: "feat" | "fix" | "refactor" = "feat",
	): void {
		this.autonomy.startTask(description, type);
		this.updateContext({ currentTask: description });
		this.emit("task:started", { description, type });
	}

	/**
	 * Complete current task (merges branch, clears context)
	 */
	completeTask(): boolean {
		const success = this.autonomy.completeTask();
		if (success) {
			this.updateContext({ currentTask: "" });
			this.emit("task:completed");
		}
		return success;
	}
}

// ============================================
// Factory
// ============================================

let heartbeatInstance: HeartbeatAgents | null = null;

export function getHeartbeatAgents(
	config?: Partial<HeartbeatConfig>,
): HeartbeatAgents {
	if (!heartbeatInstance) {
		heartbeatInstance = new HeartbeatAgents(config);
	}
	return heartbeatInstance;
}

export function resetHeartbeatAgents(): void {
	if (heartbeatInstance) {
		heartbeatInstance.stop();
		heartbeatInstance = null;
	}
}

export default {
	HeartbeatAgents,
	getHeartbeatAgents,
	resetHeartbeatAgents,
};
