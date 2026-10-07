/**
 * spawn_agent, check_agent and list_agents: one implementation for both tool
 * paths. The text-tool ToolExecutor (packages/eight/tools.ts) and the native
 * AI SDK tools (packages/ai/tools.ts) both call these, and both take their
 * descriptions from here, so neither can drift from the other. Before this the
 * native copy had no allowedPaths and none of check_agent's outcome signals
 * (#3112), which a native-path Orchestrator never saw.
 */

import {
	type PermissionMode,
	type PermissionModeHolder,
	clampChildMode,
	claudeRuntimeRefusal,
	createChildHolder,
	createPermissionHolder,
	currentPermissionHolder,
	currentPermissionMode,
	effectivePermissionMode,
	guardedSkipsCard,
	isPermissionMode,
	planModeRefusal,
	runWithPermissionHolder,
	systemOneEnvFor,
} from "../permissions/permission-mode";

export const SPAWN_AGENT_DESCRIPTION =
	"[SHELL] Launches a background agent and returns an agentId for tracking; allowedPaths limits which files it may write or edit. When the task names the file(s) the agent may edit, always pass them as allowedPaths. Use runtime='claude' for complex multi-step tasks needing a stronger model, runtime='8gent' for standard coding tasks, runtime='shell' for simple one-off commands. The agent runs asynchronously - use check_agent with the returned ID to poll for results. For 8gent runtime, pass model='auto:free' to auto-select the best free model.";

export const ALLOWED_PATHS_DESCRIPTION =
	"Only for 8gent runtime: the files (or directories) this agent may write or edit. Writes and edits anywhere else are refused and never run. Omit for no limit.";

export const PERMISSION_MODE_DESCRIPTION =
	"Optional permission mode for the child: 'plan' (read-only), 'ask', 'guarded' (System One in front of shell commands) or 'infinite'. Omit to inherit yours. A child is never more permissive than you: asking for more gives it your mode.";

/**
 * The mode a caller with no permission mode bound is treated as when it asks
 * for a child mode: infinite if the process-wide flag is on, else ask.
 */
async function legacyParentMode(): Promise<PermissionMode> {
	const { getPermissionManager } = await import("../permissions");
	return getPermissionManager().isInfiniteMode() ? "infinite" : "ask";
}

/**
 * A shell-runtime child runs its task through sh -c, so in a permission mode
 * it passes the same gate run_command does, in the child's (clamped) mode:
 * the permission check, System One (forced on in guarded), then the card
 * unless infinite or a guarded allow covers it. Null: may run.
 */
async function gateShellChild(
	command: string,
	cwd: string,
	holder: PermissionModeHolder | undefined,
): Promise<string | null> {
	const gate = async (): Promise<string | null> => {
		const mode = currentPermissionMode();
		if (mode === "plan") {
			const refusal = await planModeRefusal("run_command", { command });
			if (refusal) return refusal;
		}
		const { getPermissionManager, isCommandDangerous } = await import("../permissions");
		const pm = getPermissionManager();
		const check = pm.checkPermission(command, cwd);
		if (check === "denied")
			return `[PERMISSION DENIED] Command blocked by security policy: ${command}`;
		const { systemOneGate } = await import("../permissions/system-one-gate");
		const systemOne = await systemOneGate(command, systemOneEnvFor(mode), cwd);
		if (!systemOne.run) return systemOne.message as string;
		const dangerous = isCommandDangerous(command, cwd);
		if (
			check === "ask" &&
			systemOne.humanApproved !== true &&
			!guardedSkipsCard(mode, systemOne, dangerous)
		) {
			const allowed = await pm.requestPermission(
				"Spawn Shell Agent",
				dangerous
					? "This command may modify system files or cause data loss."
					: "The agent wants to run a shell command as a background agent.",
				command,
				{ cwd },
			);
			if (!allowed) return `[PERMISSION DENIED] User declined to execute: ${command}`;
		}
		return null;
	};
	return holder ? runWithPermissionHolder(holder, gate) : gate();
}

export const CHECK_AGENT_DESCRIPTION =
	"[SHELL] Returns the status (running/completed/failed) of a background agent, the files it changed, and an outcome line saying whether its task is done. While it runs, waits up to 90s for it or any sibling to finish, so no sleep is needed between checks. If the outcome or respawnNow says an agent ended without doing its task, re-spawn it at once, before checking the others.";

export const LIST_AGENTS_DESCRIPTION =
	"[SHELL] Returns a summary of all spawned background agents with their IDs, runtimes, statuses, and elapsed times. Use this to get an overview before checking individual agents, or to find an agentId you lost track of.";

/**
 * How long check_agent waits on a running 8gent agent for it or a sibling to
 * finish (ms). EIGHT_CHECK_AGENT_WAIT_MS overrides; 0 answers at once.
 *
 * 90 s (#3583): every pool child runs on the local model, and each early
 * "still running" costs the parent an inference turn on that same model. At
 * 20 s the parent of pilot orch-route-three made 35 checks while its children
 * took 60 to 170 s a step. The wait still ends the moment any agent finishes.
 */
export function checkAgentWaitMs(): number {
	const raw = process.env.EIGHT_CHECK_AGENT_WAIT_MS?.trim();
	const ms = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(ms) && ms >= 0 ? ms : 90_000;
}

export async function spawnAgentTool(
	workingDirectory: string,
	task: string,
	runtime?: "8gent" | "claude" | "shell",
	model?: string,
	timeout?: number,
	allowedPaths?: string[],
	permissionMode?: unknown,
): Promise<string> {
	try {
		// Recursion cap (#3331): refused before anything is resolved or started.
		const { agentDepthRefusal, currentAgentDepth, AGENT_DEPTH_ENV } = await import("./index");
		const depthRefusal = agentDepthRefusal();
		if (depthRefusal) return depthRefusal;

		const effectiveRuntime = runtime || "8gent";

		// Permission modes (#3170). The child inherits the caller's mode and is
		// never more permissive: a requested mode is clamped to the caller's.
		// No mode bound and none requested: exactly today's behaviour.
		const requested = isPermissionMode(permissionMode) ? permissionMode : undefined;
		const parent = currentPermissionHolder();
		let child: PermissionModeHolder | undefined;
		if (parent) {
			const parentMode = effectivePermissionMode(parent);
			if (parentMode === "plan") return (await planModeRefusal("spawn_agent", {})) as string;
			child = createChildHolder(parent, requested);
		} else if (requested) {
			child = createPermissionHolder(clampChildMode(await legacyParentMode(), requested));
		}
		if (child && effectiveRuntime === "claude") {
			const refusal = claudeRuntimeRefusal(effectivePermissionMode(child));
			if (refusal) return refusal;
		}

		// CLI runtimes: claude and shell
		if (effectiveRuntime === "claude" || effectiveRuntime === "shell") {
			// runtime "shell" runs the task through sh -c, so it is a shell command.
			// With no permission holder it passes the same gate in the
			// process-wide mode: permission check, System One, then the card.
			if (effectiveRuntime === "shell") {
				const blocked = await gateShellChild(task, workingDirectory, child);
				if (blocked) return blocked;
			}
			const { spawnCLIAgent } = await import("./index");
			const agent = spawnCLIAgent(effectiveRuntime, task, {
				workingDirectory: workingDirectory,
				timeout: timeout || undefined,
				// A process child starts at this depth, so an 8gent it runs is capped too.
				env: { [AGENT_DEPTH_ENV]: String(currentAgentDepth() + 1) },
			});
			return JSON.stringify(
				{
					agentId: agent.id,
					runtime: effectiveRuntime,
					status: "running",
					task: task.slice(0, 100),
					message: `CLI agent ${agent.id} (${effectiveRuntime}) spawned and running. Use check_agent("${agent.id}") to check status.`,
				},
				null,
				2,
			);
		}

		// Default: 8gent runtime
		// Resolve "auto:free" to the best available free model via OpenRouter
		let resolvedModel = model;
		if (model === "auto:free") {
			try {
				const { resolveModel } = await import("../providers");
				const resolved = await resolveModel(model);
				resolvedModel = resolved.model;
			} catch {
				// Fall back to default if provider resolution fails
				resolvedModel = undefined;
			}
		}
		const { getAgentPool } = await import("./index");
		const pool = getAgentPool();
		const agent = await pool.spawnAgent(task, {
			model: resolvedModel || undefined,
			workingDirectory: workingDirectory,
			allowedPaths,
			...(child ? { permission: child } : {}),
		});
		return JSON.stringify(
			{
				agentId: agent.id,
				runtime: "8gent",
				status: agent.status,
				task: task.slice(0, 100),
				...(child ? { permissionMode: effectivePermissionMode(child) } : {}),
				...(allowedPaths
					? { allowedPaths }
					: {
							scope:
								"none: this agent may write any file. If the task names the file(s) it may edit, pass them as allowedPaths.",
						}),
				message: `Agent ${agent.id} spawned and running. Use check_agent("${agent.id}") to check status.`,
			},
			null,
			2,
		);
	} catch (err) {
		return `Failed to spawn agent: ${err}`;
	}
}

export async function checkAgentTool(agentId: string): Promise<string> {
	try {
		// Check CLI agents first (claude/shell runtimes)
		if (agentId.startsWith("cli-")) {
			const { getCLIAgentStatus } = await import("./index");
			const status = getCLIAgentStatus(agentId);
			if (!status) return `Agent not found: ${agentId}`;

			const result: Record<string, unknown> = {
				agentId: status.id,
				runtime: status.runtime,
				status: status.status,
				task: status.task,
				elapsed: status.elapsed,
			};

			if (status.result) {
				result.stdout = status.result.stdout.slice(0, 2000);
				if (status.result.stderr) {
					result.stderr = status.result.stderr.slice(0, 500);
				}
				result.exitCode = status.result.exitCode;
			}

			return JSON.stringify(result, null, 2);
		}

		// Default: check 8gent agent pool
		const { getAgentPool } = await import("./index");
		const { agentOutcome, pendingRespawns } = await import("./agent-outcome");
		const pool = getAgentPool();
		const agent = pool.getAgent(agentId);
		if (!agent) return `Agent not found: ${agentId}`;

		// A running agent: wait (bounded) for it or any sibling to finish, so a
		// sibling that ends early is reported while the others still run. Skip
		// the wait when a sibling already needs a re-spawn.
		if (pendingRespawns(pool.listAgents(), agent.id).length === 0) {
			await pool.waitForAnyFinish(agent.id, checkAgentWaitMs());
		}

		const elapsed = agent.completedAt
			? `${((agent.completedAt.getTime() - agent.startedAt.getTime()) / 1000).toFixed(1)}s`
			: `${((Date.now() - agent.startedAt.getTime()) / 1000).toFixed(1)}s (running)`;

		// Outcome first: whether the task is done, not only the agent's own claim.
		const result: Record<string, unknown> = {
			agentId: agent.id,
			runtime: "8gent",
			status: agent.status,
			outcome: agentOutcome(agent),
			filesChanged: agent.filesChanged,
			...(agent.config.allowedPaths ? { allowedPaths: agent.config.allowedPaths } : {}),
			task: agent.task.description,
			elapsed,
		};

		if (agent.status === "completed" && agent.task.result) {
			result.result =
				typeof agent.task.result === "string"
					? agent.task.result.slice(0, 2000)
					: JSON.stringify(agent.task.result).slice(0, 2000);
		}
		if (agent.status === "failed" && agent.task.error) {
			result.error = agent.task.error;
		}
		const respawn = pendingRespawns(pool.listAgents(), agent.id);
		if (respawn.length > 0) {
			result.respawnNow = respawn.map((a) => ({
				agentId: a.id,
				...(a.config.allowedPaths ? { allowedPaths: a.config.allowedPaths } : {}),
				outcome: agentOutcome(a),
			}));
		}

		return JSON.stringify(result, null, 2);
	} catch (err) {
		return `Failed to check agent: ${err}`;
	}
}

export async function listAgentsTool(): Promise<string> {
	try {
		const { getAgentPool, listCLIAgents, getCLIAgentStatus } = await import("./index");
		const pool = getAgentPool();
		const poolAgents = pool.listAgents();
		const cliAgentsList = listCLIAgents();

		if (poolAgents.length === 0 && cliAgentsList.length === 0) {
			return "No agents spawned yet. Use spawn_agent to create background agents for parallel tasks.";
		}

		const stats = pool.getStats();

		// 8gent agents
		const eightAgentList = poolAgents.map((a) => {
			const elapsed = a.completedAt
				? `${((a.completedAt.getTime() - a.startedAt.getTime()) / 1000).toFixed(1)}s`
				: `${((Date.now() - a.startedAt.getTime()) / 1000).toFixed(1)}s`;
			return {
				id: a.id,
				runtime: "8gent" as const,
				status: a.status,
				task: a.task.description.slice(0, 80),
				elapsed,
				hasResult: a.status === "completed" && !!a.task.result,
			};
		});

		// CLI agents (claude/shell)
		const cliAgentList = cliAgentsList.map((a) => {
			const status = getCLIAgentStatus(a.id);
			return {
				id: a.id,
				runtime: a.runtime,
				status: status?.status || "running",
				task: a.task.slice(0, 80),
				elapsed: status?.elapsed || "...",
				hasResult: !!a.result,
			};
		});

		const allAgents = [...eightAgentList, ...cliAgentList];

		// Augment stats with CLI agents
		const cliRunning = cliAgentsList.filter((a) => !a.completedAt).length;
		const cliCompleted = cliAgentsList.filter(
			(a) => a.completedAt && a.result?.exitCode === 0,
		).length;
		const cliFailed = cliAgentsList.filter((a) => a.completedAt && a.result?.exitCode !== 0).length;

		return JSON.stringify(
			{
				stats: {
					...stats,
					totalAgents: stats.totalAgents + cliAgentsList.length,
					running: stats.running + cliRunning,
					completed: stats.completed + cliCompleted,
					failed: stats.failed + cliFailed,
				},
				agents: allAgents,
			},
			null,
			2,
		);
	} catch (err) {
		return `Failed to list agents: ${err}`;
	}
}
