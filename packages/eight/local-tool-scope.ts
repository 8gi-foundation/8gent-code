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
 * Orchestration-category tools the local catalog must not advertise for this
 * role: every one it does not register.
 */
export function localCatalogOmissions(role: string | undefined): string[] {
	const registered = new Set(localDelegationTools(role));
	return (TOOL_CATEGORIES.orchestration ?? []).filter((t) => !registered.has(t));
}
