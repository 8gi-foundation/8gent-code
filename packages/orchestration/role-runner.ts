/**
 * role-runner.ts - execute a claimed task with a role-specific client.
 *
 * Thin helper that future callers (TUI, dispatcher wiring, CLI) can use to
 * run a claimed task through the role config system without reimplementing
 * client construction. Reuses the existing `Agent` loop from
 * `packages/eight/agent.ts` so tools, hooks, memory, and policies all come
 * along for the ride.
 */

import { RoleProviderUnavailableError, createClientForRole } from "../eight/clients";
import type { AgentConfig } from "../eight/types";
import { type ProviderName, getProviderManager } from "../providers";
import { type RoleName, loadRoleConfig } from "./role-config";
import type { DispatchedTask } from "./task-dispatcher";
import { globalDispatcher } from "./task-dispatcher";

export interface RunClaimedTaskResult {
	taskId: string;
	role: RoleName;
	provider: string;
	model: string;
	output: string;
}

function runtimeForProvider(provider: ProviderName): AgentConfig["runtime"] {
	switch (provider) {
		case "apple-foundation":
			return "apple-foundation";
		case "openrouter":
		case "groq":
		case "grok":
		case "openai":
		case "anthropic":
		case "mistral":
		case "together":
		case "fireworks":
		case "replicate":
			return "openrouter";
		default:
			return "ollama";
	}
}

/**
 * Run a claimed task with the role's configured provider + model.
 *
 * Callers must `claim()` the task first. This helper transitions the task
 * through `start -> complete` (or `fail` on error) and returns the agent
 * output. If the role's provider is unavailable, the task is failed with a
 * clear error and `RoleProviderUnavailableError` is rethrown.
 *
 * The trace line `dispatcher.run role=<role> provider=<provider> model=<model> taskId=<id>`
 * is emitted to stdout so downstream tests can grep for it.
 */
export async function runClaimedTask(
	role: RoleName,
	task: DispatchedTask,
): Promise<RunClaimedTaskResult> {
	const cfg = loadRoleConfig();
	const assignment = cfg[role];

	console.log(
		`dispatcher.run role=${role} provider=${assignment.provider} model=${assignment.model} taskId=${task.id}`,
	);

	// Validate provider up front. This throws RoleProviderUnavailableError
	// with a clear message if the role's provider is disabled on this host,
	// letting the caller surface an install wizard.
	try {
		createClientForRole(role);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		globalDispatcher.fail(task.id, msg);
		throw err;
	}

	globalDispatcher.start(task.id);

	try {
		// Lazy-import Agent so orchestration consumers that only need dispatch
		// state don't pull in the full agent graph at module load.
		const { Agent } = await import("../eight/agent");
		const pm = getProviderManager();
		const apiKey = pm.getApiKey(assignment.provider) ?? undefined;
		const agentConfig: AgentConfig = {
			runtime: runtimeForProvider(assignment.provider),
			model: assignment.model,
			apiKey,
		};
		const agent = new Agent(agentConfig);
		const output = await agent.chat(task.title);
		globalDispatcher.complete(task.id, output);
		return {
			taskId: task.id,
			role,
			provider: assignment.provider,
			model: assignment.model,
			output,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		globalDispatcher.fail(task.id, msg);
		throw err;
	}
}

export { RoleProviderUnavailableError };
