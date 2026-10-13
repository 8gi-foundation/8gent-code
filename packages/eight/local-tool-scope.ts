/**
 * Which delegation tools an agent gets on the local text-tool path (#3095).
 *
 * Local providers (ollama, lmstudio) run a lean tool set to spare small
 * models the context cost. Delegation (spawn_agent, check_agent,
 * list_agents) is only useful to the agent that hands work out, so only the
 * Orchestrator registers it. Engineer and QA tabs, spawned sub-agents and
 * agents with no role keep the lean set, and the prompt they see advertises
 * exactly what they have: a tool that is advertised but not registered gets
 * called and fails (#3091).
 */

import { PLANNING_GATE_INSTRUCTION } from "./prompt";
import { TOOL_CATEGORIES } from "./tool-registry";

/** The workspace roles a TUI chat tab can carry. */
export type AgentRole = "orchestrator" | "engineer" | "qa";

/** The delegation tools the Orchestrator registers on the local path. */
export const DELEGATION_TOOLS: readonly string[] = ["spawn_agent", "check_agent", "list_agents"];

/** The delegation tools this role registers on the local text-tool path. */
export function localDelegationTools(role: string | undefined): string[] {
	return role === "orchestrator" ? [...DELEGATION_TOOLS] : [];
}

/**
 * The plan tools an agent registers on the local text-tool path (#3583). A
 * spawned sub-agent (depth 1 or more) has one task and no PLAN column of its
 * own, so update_plan is only noise: in pilot orch-route-three it was 17 of
 * the children's 30 tool calls on a model the four agents shared.
 */
export function localPlanTools(depth: number): string[] {
	return depth > 0 ? [] : ["update_plan"];
}

/**
 * Tools the local catalog must not advertise for this role and depth: every
 * orchestration tool it does not register, and update_plan for a sub-agent.
 */
export function localCatalogOmissions(role: string | undefined, depth = 0): string[] {
	const registered = new Set([...localDelegationTools(role), ...localPlanTools(depth)]);
	return [...(TOOL_CATEGORIES.orchestration ?? []), "update_plan"].filter(
		(t) => !registered.has(t),
	);
}

/**
 * The planning gate for an agent at this depth. A sub-agent still plans and
 * executes at once, but is not told to report through update_plan, a tool it
 * does not have (#3091).
 */
export function planningGateInstruction(depth: number): string {
	if (localPlanTools(depth).length > 0) return PLANNING_GATE_INSTRUCTION;
	const cut = PLANNING_GATE_INSTRUCTION.indexOf(" Report progress as you go:");
	return cut < 0 ? PLANNING_GATE_INSTRUCTION : PLANNING_GATE_INSTRUCTION.slice(0, cut);
}
