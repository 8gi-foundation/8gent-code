/**
 * 8gent Code - Delegation System
 *
 * Improved delegation prompts for subagent creation and task distribution.
 * Implements structured handoff protocols and context transfer.
 */

import type { SubAgentConfig, SubAgent } from "./subagent";
import type { Step } from "../workflow/plan-validate";

// ============================================
// Types
// ============================================

export interface DelegationRequest {
	task: string;
	context: DelegationContext;
	constraints: DelegationConstraints;
	parentAgentId?: string;
}

export interface DelegationContext {
	workingDirectory: string;
	relevantFiles: string[];
	previousSteps: string[];
	sharedState: Record<string, unknown>;
	parentPlan?: Step[];
}

export interface DelegationConstraints {
	maxTokens?: number;
	maxTurns?: number;
	timeout?: number;
	requiredEvidence?: string[];
	forbiddenTools?: string[];
	mustValidate?: boolean;
}

export interface DelegationResult {
	agentId: string;
	success: boolean;
	result?: string;
	evidence: Array<{
		type: string;
		description: string;
		verified: boolean;
	}>;
	tokensUsed: number;
	duration: number;
}

// ============================================
// Delegation Prompts
// ============================================

/**
 * Generate a focused delegation prompt for a subagent
 */
export function generateDelegationPrompt(request: DelegationRequest): string {
	const { task, context, constraints } = request;

	return `## DELEGATION BRIEF

### Task
${task}

### Context
- Working directory: ${context.workingDirectory}
- Relevant files: ${context.relevantFiles.slice(0, 5).join(", ") || "None specified"}
${context.previousSteps.length > 0 ? `- Previous steps completed: ${context.previousSteps.length}` : ""}

### Constraints
- Max turns: ${constraints.maxTurns || 20}
- Must validate: ${constraints.mustValidate !== false}
${constraints.requiredEvidence?.length ? `- Required evidence: ${constraints.requiredEvidence.join(", ")}` : ""}
${constraints.forbiddenTools?.length ? `- Forbidden tools: ${constraints.forbiddenTools.join(", ")}` : ""}

### Execution Protocol
1. Understand the task fully
2. Plan your approach (max 5 steps)
3. Execute each step with validation
4. Collect required evidence
5. Report completion with confidence score

### Output Format
After completing:
\`\`\`json
{
  "status": "complete" | "failed" | "blocked",
  "summary": "What was accomplished",
  "evidence": [{"type": "...", "description": "...", "verified": true}],
  "confidence": 0-100,
  "blockers": [] // if any
}
\`\`\`

BEGIN EXECUTION:`;
}

/**
 * Generate a structured handoff message between agents
 */
export function generateHandoffPrompt(
	fromAgent: string,
	toAgent: string,
	task: string,
	context: {
		completedSteps: string[];
		pendingSteps: string[];
		state: Record<string, unknown>;
		warnings?: string[];
	},
): string {
	return `## AGENT HANDOFF

### From
Agent: ${fromAgent}
Status: Handing off task

### To
Agent: ${toAgent}
Task: ${task}

### Context Transfer
**Completed Steps:**
${context.completedSteps.map((s, i) => `${i + 1}. ${s}`).join("\n") || "None"}

**Pending Steps:**
${context.pendingSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

**State:**
${JSON.stringify(context.state, null, 2)}

${context.warnings?.length ? `**Warnings:**\n${context.warnings.map((w) => `- ${w}`).join("\n")}` : ""}

### Instructions
Continue from where the previous agent left off. Use the provided context.
Do not repeat completed steps. Focus on pending work.`;
}

/**
 * Generate a plan decomposition prompt for breaking large tasks
 */
export function generateDecompositionPrompt(
	task: string,
	complexity: "small" | "medium" | "large",
): string {
	const stepCount =
		complexity === "small" ? "2-3" : complexity === "medium" ? "4-6" : "7-10";

	return `## TASK DECOMPOSITION

### Original Task
${task}

### Complexity
${complexity.toUpperCase()} - Break into ${stepCount} atomic steps

### Decomposition Rules
1. Each step must be independently executable
2. Each step must have clear success criteria
3. Steps should be ordered by dependencies
4. Identify parallelizable step groups
5. Include validation steps

### Output Format
\`\`\`json
{
  "plan": [
    {
      "id": "step_1",
      "action": "What to do",
      "expected": "Success criteria",
      "tool": "Primary tool to use",
      "dependencies": [],
      "parallel_group": 1,
      "evidence_type": "file_exists | test_result | command_output"
    }
  ],
  "parallel_groups": {
    "1": ["step_1", "step_2"],
    "2": ["step_3"]
  },
  "estimated_tokens": 5000,
  "estimated_time_seconds": 120
}
\`\`\`

DECOMPOSE:`;
}

// ============================================
// Delegation Manager
// ============================================

export class DelegationManager {
	private activeDelegations: Map<string, DelegationRequest> = new Map();
	private completedDelegations: Map<string, DelegationResult> = new Map();
	private idCounter = 0;

	/**
	 * Create a delegation request with optimal configuration
	 */
	createDelegation(
		task: string,
		context: Partial<DelegationContext>,
		constraints?: Partial<DelegationConstraints>,
	): DelegationRequest {
		const delegationId = `deleg_${Date.now()}_${++this.idCounter}`;

		const request: DelegationRequest = {
			task,
			context: {
				workingDirectory: context.workingDirectory || process.cwd(),
				relevantFiles: context.relevantFiles || [],
				previousSteps: context.previousSteps || [],
				sharedState: context.sharedState || {},
				parentPlan: context.parentPlan,
			},
			constraints: {
				maxTokens: constraints?.maxTokens || 4000,
				maxTurns: constraints?.maxTurns || 10,
				timeout: constraints?.timeout || 60000,
				requiredEvidence: constraints?.requiredEvidence || [],
				forbiddenTools: constraints?.forbiddenTools || [],
				mustValidate: constraints?.mustValidate !== false,
			},
		};

		this.activeDelegations.set(delegationId, request);
		return request;
	}

	/**
	 * Get optimal subagent config for a delegation
	 */
	getSubagentConfig(request: DelegationRequest): SubAgentConfig {
		return {
			model: this.selectModel(request),
			systemPrompt: generateDelegationPrompt(request),
			maxTurns: request.constraints.maxTurns,
			workingDirectory: request.context.workingDirectory,
			timeout: request.constraints.timeout,
			capabilities: this.inferCapabilities(request.task),
			priority: this.calculatePriority(request),
		};
	}

	/**
	 * Select appropriate model based on task complexity
	 */
	private selectModel(request: DelegationRequest): string {
		// Analyze task complexity
		const taskLength = request.task.length;
		const stepCount = request.context.parentPlan?.length || 0;

		if (taskLength < 100 && stepCount <= 2) {
			return "glm-4.7-flash:latest"; // Fast model for simple tasks
		}

		return "glm-4.7-flash:latest"; // Default model
	}

	/**
	 * Infer required capabilities from task description
	 */
	private inferCapabilities(task: string): string[] {
		const capabilities: string[] = [];
		const taskLower = task.toLowerCase();

		if (
			taskLower.includes("file") ||
			taskLower.includes("create") ||
			taskLower.includes("write")
		) {
			capabilities.push("file_operations");
		}
		if (
			taskLower.includes("git") ||
			taskLower.includes("commit") ||
			taskLower.includes("push")
		) {
			capabilities.push("git_operations");
		}
		if (
			taskLower.includes("test") ||
			taskLower.includes("verify") ||
			taskLower.includes("check")
		) {
			capabilities.push("testing");
		}
		if (
			taskLower.includes("search") ||
			taskLower.includes("find") ||
			taskLower.includes("explore")
		) {
			capabilities.push("code_exploration");
		}
		if (
			taskLower.includes("run") ||
			taskLower.includes("execute") ||
			taskLower.includes("command")
		) {
			capabilities.push("shell_execution");
		}

		return capabilities;
	}

	/**
	 * Calculate priority based on task characteristics
	 */
	private calculatePriority(request: DelegationRequest): number {
		let priority = 5; // Default

		// Higher priority for smaller, focused tasks
		if (request.task.length < 100) priority += 2;

		// Higher priority if part of active plan
		if (request.context.parentPlan) priority += 1;

		// Higher priority for validation tasks
		if (request.constraints.mustValidate) priority += 1;

		return Math.min(10, priority);
	}

	/**
	 * Record delegation completion
	 */
	recordCompletion(delegationId: string, result: DelegationResult): void {
		this.completedDelegations.set(delegationId, result);
		this.activeDelegations.delete(delegationId);
	}

	/**
	 * Get delegation statistics
	 */
	getStats(): {
		active: number;
		completed: number;
		successRate: number;
		avgDuration: number;
		avgTokens: number;
	} {
		const completed = Array.from(this.completedDelegations.values());
		const successful = completed.filter((d) => d.success);

		return {
			active: this.activeDelegations.size,
			completed: completed.length,
			successRate:
				completed.length > 0 ? successful.length / completed.length : 0,
			avgDuration:
				completed.length > 0
					? completed.reduce((sum, d) => sum + d.duration, 0) / completed.length
					: 0,
			avgTokens:
				completed.length > 0
					? completed.reduce((sum, d) => sum + d.tokensUsed, 0) /
						completed.length
					: 0,
		};
	}
}

// ============================================
// Singleton
// ============================================

let delegationManagerInstance: DelegationManager | null = null;

export function getDelegationManager(): DelegationManager {
	if (!delegationManagerInstance) {
		delegationManagerInstance = new DelegationManager();
	}
	return delegationManagerInstance;
}

export function resetDelegationManager(): void {
	delegationManagerInstance = null;
}
