/**
 * 8gent Code - BMAD Process Integration
 *
 * Breakthrough Method of Agile AI-driven Development
 * Structured task breakdown with clear acceptance criteria and Kanban integration.
 */

import { EventEmitter } from "node:events";
import type { Evidence } from "../validation/evidence";
import type { Step } from "./plan-validate";

// ============================================
// Types
// ============================================

export type BMadTaskSize = "trivial" | "small" | "medium" | "large" | "epic";

export interface BMadTask {
	id: string;
	title: string;
	description: string;
	size: BMadTaskSize;
	status: BMadStatus;
	acceptanceCriteria: AcceptanceCriterion[];
	steps: BMadStep[];
	createdAt: Date;
	updatedAt: Date;
	completedAt?: Date;
	assignedAgent?: string;
	parentTaskId?: string;
	childTaskIds: string[];
	labels: string[];
	priority: number;
	estimatedTokens: number;
	actualTokens?: number;
}

export type BMadStatus =
	| "backlog" // Not started, in queue
	| "ready" // Ready to pick up
	| "in_progress" // Currently being worked on
	| "blocked" // Waiting on something
	| "review" // Needs validation
	| "done"; // Completed with evidence

export interface AcceptanceCriterion {
	id: string;
	description: string;
	evidenceType: string;
	verified: boolean;
	evidence?: Evidence;
}

export interface BMadStep {
	id: string;
	action: string;
	status: "pending" | "in_progress" | "done" | "skipped";
	tool?: string;
	evidence?: Evidence[];
	startedAt?: Date;
	completedAt?: Date;
}

export interface BMadColumn {
	id: BMadStatus;
	name: string;
	tasks: BMadTask[];
	wipLimit?: number;
}

export interface BMadBoard {
	id: string;
	name: string;
	columns: BMadColumn[];
	createdAt: Date;
	updatedAt: Date;
}

// ============================================
// Task Classification
// ============================================

export function classifyTaskSize(
	description: string,
	hints?: {
		fileCount?: number;
		complexity?: string;
		dependencies?: number;
	},
): BMadTaskSize {
	const desc = description.toLowerCase();

	// Check explicit hints first
	if (hints?.fileCount) {
		if (hints.fileCount <= 1) return "trivial";
		if (hints.fileCount <= 3) return "small";
		if (hints.fileCount <= 7) return "medium";
		if (hints.fileCount <= 15) return "large";
		return "epic";
	}

	// Keyword-based classification
	const trivialPatterns = [
		"rename",
		"typo",
		"comment",
		"log",
		"console",
		"format",
		"whitespace",
		"import",
	];
	const smallPatterns = [
		"add function",
		"fix bug",
		"update",
		"change",
		"modify",
		"edit",
		"adjust",
	];
	const mediumPatterns = [
		"create feature",
		"implement",
		"add component",
		"refactor",
		"migrate",
		"upgrade",
	];
	const largePatterns = [
		"build",
		"redesign",
		"overhaul",
		"rewrite",
		"integrate",
		"new module",
		"new package",
	];
	const epicPatterns = [
		"rebuild",
		"new project",
		"architecture",
		"major feature",
		"system",
		"platform",
	];

	if (epicPatterns.some((p) => desc.includes(p))) return "epic";
	if (largePatterns.some((p) => desc.includes(p))) return "large";
	if (mediumPatterns.some((p) => desc.includes(p))) return "medium";
	if (smallPatterns.some((p) => desc.includes(p))) return "small";
	if (trivialPatterns.some((p) => desc.includes(p))) return "trivial";

	// Default based on length
	if (desc.length < 50) return "small";
	if (desc.length < 150) return "medium";
	return "large";
}

/**
 * Generate acceptance criteria from task description
 */
export function generateAcceptanceCriteria(
	task: string,
	size: BMadTaskSize,
): AcceptanceCriterion[] {
	const criteria: AcceptanceCriterion[] = [];
	const taskLower = task.toLowerCase();
	let idCounter = 0;

	const addCriterion = (desc: string, evidenceType: string) => {
		criteria.push({
			id: `ac_${++idCounter}`,
			description: desc,
			evidenceType,
			verified: false,
		});
	};

	// File-related criteria
	if (taskLower.includes("create") || taskLower.includes("add file")) {
		addCriterion("New file exists at specified path", "file_exists");
		addCriterion("File contains required content", "file_content");
	}

	if (
		taskLower.includes("edit") ||
		taskLower.includes("modify") ||
		taskLower.includes("update")
	) {
		addCriterion("Changes applied to target file", "file_content");
		addCriterion("No syntax errors in modified code", "command_output");
	}

	// Test-related criteria
	if (taskLower.includes("test") || size === "medium" || size === "large") {
		addCriterion("All tests pass", "test_result");
	}

	// Build-related criteria
	if (taskLower.includes("build") || taskLower.includes("compile")) {
		addCriterion("Build completes without errors", "command_output");
	}

	// Git-related criteria
	if (size !== "trivial") {
		addCriterion(
			"Changes committed with conventional commit message",
			"git_commit",
		);
	}

	// Type-check criteria for TypeScript
	if (taskLower.includes(".ts") || taskLower.includes("typescript")) {
		addCriterion("TypeScript compiles without errors", "command_output");
	}

	// Default criterion
	if (criteria.length === 0) {
		addCriterion("Task completed successfully", "command_output");
	}

	return criteria;
}

/**
 * Break down a task into steps based on size
 */
export function decomposeTask(task: string, size: BMadTaskSize): BMadStep[] {
	const steps: BMadStep[] = [];
	let idCounter = 0;

	const addStep = (action: string, tool?: string) => {
		steps.push({
			id: `step_${++idCounter}`,
			action,
			status: "pending",
			tool,
		});
	};

	switch (size) {
		case "trivial":
			addStep(`Execute: ${task}`, "edit_file");
			break;

		case "small":
			addStep("Analyze affected files", "get_outline");
			addStep(`Execute: ${task}`, "edit_file");
			addStep("Verify changes", "read_file");
			break;

		case "medium":
			addStep("Explore relevant code structure", "search_symbols");
			addStep("Get outlines of affected files", "get_outline");
			addStep("Read key file contents", "read_file");
			addStep(`Implement: ${task}`, "write_file");
			addStep("Run type check", "run_command");
			addStep("Run tests", "run_command");
			addStep("Commit changes", "git_commit");
			break;

		case "large":
			addStep("Search for related symbols", "search_symbols");
			addStep("Map dependencies", "get_outline");
			addStep("Analyze existing implementation", "read_file");
			addStep("Create implementation plan", undefined);
			addStep("Implement core changes", "write_file");
			addStep("Implement supporting changes", "edit_file");
			addStep("Add tests", "write_file");
			addStep("Run full test suite", "run_command");
			addStep("Run linter", "run_command");
			addStep("Commit with detailed message", "git_commit");
			break;

		case "epic":
			// Epics should be broken into smaller tasks
			addStep("Break down into subtasks", undefined);
			addStep("Create child tasks for each component", undefined);
			addStep("Execute child tasks in order", undefined);
			addStep("Validate all components", "run_command");
			addStep("Integration testing", "run_command");
			addStep("Final commit", "git_commit");
			break;
	}

	return steps;
}

// ============================================
// Kanban Board Manager
// ============================================

export class KanbanBoard extends EventEmitter {
	private board: BMadBoard;
	private taskIndex: Map<string, BMadTask> = new Map();
	private idCounter = 0;

	constructor(name = "8gent Board") {
		super();
		this.board = {
			id: `board_${Date.now()}`,
			name,
			columns: [
				{ id: "backlog", name: "Backlog", tasks: [] },
				{ id: "ready", name: "Ready", tasks: [], wipLimit: 5 },
				{ id: "in_progress", name: "In Progress", tasks: [], wipLimit: 3 },
				{ id: "blocked", name: "Blocked", tasks: [] },
				{ id: "review", name: "Review", tasks: [], wipLimit: 5 },
				{ id: "done", name: "Done", tasks: [] },
			],
			createdAt: new Date(),
			updatedAt: new Date(),
		};
	}

	/**
	 * Create a new task from description
	 */
	createTask(
		title: string,
		description: string,
		options?: {
			size?: BMadTaskSize;
			priority?: number;
			labels?: string[];
			parentTaskId?: string;
		},
	): BMadTask {
		const size = options?.size || classifyTaskSize(description);
		const task: BMadTask = {
			id: `task_${Date.now()}_${++this.idCounter}`,
			title,
			description,
			size,
			status: "backlog",
			acceptanceCriteria: generateAcceptanceCriteria(description, size),
			steps: decomposeTask(description, size),
			createdAt: new Date(),
			updatedAt: new Date(),
			parentTaskId: options?.parentTaskId,
			childTaskIds: [],
			labels: options?.labels || [],
			priority: options?.priority || 5,
			estimatedTokens: this.estimateTokens(size),
		};

		// Add to backlog
		this.board.columns[0].tasks.push(task);
		this.taskIndex.set(task.id, task);

		// Link to parent if specified
		if (options?.parentTaskId) {
			const parent = this.taskIndex.get(options.parentTaskId);
			if (parent) {
				parent.childTaskIds.push(task.id);
			}
		}

		this.emit("task:created", task);
		return task;
	}

	/**
	 * Move task to a new status column
	 */
	moveTask(taskId: string, newStatus: BMadStatus): boolean {
		const task = this.taskIndex.get(taskId);
		if (!task) return false;

		const oldColumn = this.board.columns.find((c) => c.id === task.status);
		const newColumn = this.board.columns.find((c) => c.id === newStatus);

		if (!oldColumn || !newColumn) return false;

		// Check WIP limit
		if (newColumn.wipLimit && newColumn.tasks.length >= newColumn.wipLimit) {
			this.emit("wip:exceeded", { column: newColumn, task });
			return false;
		}

		// Remove from old column
		const taskIndex = oldColumn.tasks.findIndex((t) => t.id === taskId);
		if (taskIndex >= 0) {
			oldColumn.tasks.splice(taskIndex, 1);
		}

		// Add to new column
		task.status = newStatus;
		task.updatedAt = new Date();
		newColumn.tasks.push(task);

		if (newStatus === "done") {
			task.completedAt = new Date();
		}

		this.emit("task:moved", { task, from: oldColumn.id, to: newColumn.id });
		return true;
	}

	/**
	 * Update task step status
	 */
	updateStep(
		taskId: string,
		stepId: string,
		status: BMadStep["status"],
		evidence?: Evidence[],
	): boolean {
		const task = this.taskIndex.get(taskId);
		if (!task) return false;

		const step = task.steps.find((s) => s.id === stepId);
		if (!step) return false;

		step.status = status;
		if (status === "in_progress") {
			step.startedAt = new Date();
		} else if (status === "done") {
			step.completedAt = new Date();
			if (evidence) {
				step.evidence = evidence;
			}
		}

		task.updatedAt = new Date();
		this.emit("step:updated", { task, step });

		// Check if all steps are done
		const allDone = task.steps.every(
			(s) => s.status === "done" || s.status === "skipped",
		);
		if (allDone && task.status === "in_progress") {
			this.moveTask(taskId, "review");
		}

		return true;
	}

	/**
	 * Verify acceptance criterion
	 */
	verifyCriterion(
		taskId: string,
		criterionId: string,
		evidence: Evidence,
	): boolean {
		const task = this.taskIndex.get(taskId);
		if (!task) return false;

		const criterion = task.acceptanceCriteria.find((c) => c.id === criterionId);
		if (!criterion) return false;

		criterion.evidence = evidence;
		criterion.verified = evidence.verified;
		task.updatedAt = new Date();

		this.emit("criterion:verified", { task, criterion });

		// Check if all criteria are met
		const allMet = task.acceptanceCriteria.every((c) => c.verified);
		if (allMet && task.status === "review") {
			this.moveTask(taskId, "done");
		}

		return true;
	}

	/**
	 * Assign agent to task
	 */
	assignAgent(taskId: string, agentId: string): boolean {
		const task = this.taskIndex.get(taskId);
		if (!task) return false;

		task.assignedAgent = agentId;
		task.updatedAt = new Date();
		this.emit("task:assigned", { task, agentId });
		return true;
	}

	/**
	 * Get task by ID
	 */
	getTask(taskId: string): BMadTask | undefined {
		return this.taskIndex.get(taskId);
	}

	/**
	 * Get tasks by status
	 */
	getTasksByStatus(status: BMadStatus): BMadTask[] {
		const column = this.board.columns.find((c) => c.id === status);
		return column?.tasks || [];
	}

	/**
	 * Get all tasks for an agent
	 */
	getTasksByAgent(agentId: string): BMadTask[] {
		return Array.from(this.taskIndex.values()).filter(
			(t) => t.assignedAgent === agentId,
		);
	}

	/**
	 * Get next ready task (highest priority)
	 */
	getNextReadyTask(): BMadTask | undefined {
		const readyTasks = this.getTasksByStatus("ready");
		if (readyTasks.length === 0) return undefined;

		return readyTasks.sort((a, b) => b.priority - a.priority)[0];
	}

	/**
	 * Get board summary
	 */
	getSummary(): {
		total: number;
		byStatus: Record<BMadStatus, number>;
		bySize: Record<BMadTaskSize, number>;
		completionRate: number;
		avgCycleTime: number;
	} {
		const tasks = Array.from(this.taskIndex.values());
		const completed = tasks.filter((t) => t.status === "done");

		const byStatus: Record<BMadStatus, number> = {
			backlog: 0,
			ready: 0,
			in_progress: 0,
			blocked: 0,
			review: 0,
			done: 0,
		};

		const bySize: Record<BMadTaskSize, number> = {
			trivial: 0,
			small: 0,
			medium: 0,
			large: 0,
			epic: 0,
		};

		for (const task of tasks) {
			byStatus[task.status]++;
			bySize[task.size]++;
		}

		// Calculate average cycle time (time from in_progress to done)
		let totalCycleTime = 0;
		let cycleCount = 0;
		for (const task of completed) {
			if (task.completedAt) {
				const cycleTime = task.completedAt.getTime() - task.createdAt.getTime();
				totalCycleTime += cycleTime;
				cycleCount++;
			}
		}

		return {
			total: tasks.length,
			byStatus,
			bySize,
			completionRate: tasks.length > 0 ? completed.length / tasks.length : 0,
			avgCycleTime: cycleCount > 0 ? totalCycleTime / cycleCount : 0,
		};
	}

	/**
	 * Render board as text
	 */
	render(): string {
		const lines: string[] = [];
		lines.push(
			"\n╔════════════════════════════════════════════════════════════╗",
		);
		lines.push(`║  ${this.board.name.padEnd(56)}║`);
		lines.push(
			"╠════════════════════════════════════════════════════════════╣",
		);

		for (const column of this.board.columns) {
			const wipInfo = column.wipLimit
				? ` (${column.tasks.length}/${column.wipLimit})`
				: "";
			lines.push(`${`║  ${column.name}${wipInfo}`.padEnd(61)}║`);
			lines.push(`║  ${"─".repeat(56)}  ║`);

			if (column.tasks.length === 0) {
				lines.push(`║  ${"(empty)".padEnd(56)}║`);
			} else {
				for (const task of column.tasks.slice(0, 5)) {
					const icon = this.getSizeIcon(task.size);
					const title = task.title.slice(0, 45);
					lines.push(`║  ${icon} ${title.padEnd(53)}║`);
				}
				if (column.tasks.length > 5) {
					lines.push(
						`${`║  ... and ${column.tasks.length - 5} more`.padEnd(61)}║`,
					);
				}
			}
			lines.push(`${"║  ".padEnd(61)}║`);
		}

		lines.push(
			"╚════════════════════════════════════════════════════════════╝",
		);
		return lines.join("\n");
	}

	private getSizeIcon(size: BMadTaskSize): string {
		switch (size) {
			case "trivial":
				return "·";
			case "small":
				return "○";
			case "medium":
				return "◐";
			case "large":
				return "●";
			case "epic":
				return "◉";
		}
	}

	private estimateTokens(size: BMadTaskSize): number {
		switch (size) {
			case "trivial":
				return 500;
			case "small":
				return 1500;
			case "medium":
				return 3000;
			case "large":
				return 6000;
			case "epic":
				return 15000;
		}
	}
}

// ============================================
// Singleton
// ============================================

let kanbanInstance: KanbanBoard | null = null;

export function getKanbanBoard(): KanbanBoard {
	if (!kanbanInstance) {
		kanbanInstance = new KanbanBoard();
	}
	return kanbanInstance;
}

export function resetKanbanBoard(): void {
	kanbanInstance = null;
}
