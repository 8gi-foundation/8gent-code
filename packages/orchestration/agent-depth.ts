/**
 * Process agent depth (#3331, #3341): the leaf every entrypoint imports first.
 *
 * No imports, on purpose. bin/8gent.ts imports this statically, so the depth
 * is parsed when the bin loads: before main() reads ~/.8gent/keys.env, which
 * fills any unset env var and must never be able to set or change the depth.
 * index.ts re-exports everything here, so callers see one module instance and
 * one parse.
 */

/**
 * The deepest an agent may be. The user's own agent is depth 0; each spawn
 * makes a child one deeper, and a spawn that would make a child deeper than
 * this is refused at dispatch. Enforced in code, never in a prompt.
 */
export const MAX_AGENT_DEPTH = 3;

/** Env var a process child (claude / shell runtime) is started with: its depth. */
export const AGENT_DEPTH_ENV = "EIGHT_AGENT_DEPTH";

/**
 * This process's own depth, read once at load: 0 for a user's session, N for
 * a process an agent at depth N-1 started. Read once, so nothing that runs in
 * the process later can lower it by changing the env.
 *
 * Fails closed: unset or empty is 0, but any value that is not a plain
 * non-negative decimal integer (abc, -1, 3.5, 1e309, 0x3) is treated as
 * MAX_AGENT_DEPTH, so a corrupted or tampered env can never reset the budget.
 */
const PROCESS_AGENT_DEPTH = (() => {
	const raw = process.env[AGENT_DEPTH_ENV]?.trim();
	if (raw === undefined || raw === "") return 0;
	if (!/^\d+$/.test(raw)) return MAX_AGENT_DEPTH;
	const n = Number(raw);
	return Number.isSafeInteger(n) ? n : MAX_AGENT_DEPTH;
})();

/** This process's inherited depth, as parsed fail-closed at load. */
export function processAgentDepth(): number {
	return PROCESS_AGENT_DEPTH;
}

/**
 * Null when this process may run a model loop; otherwise the message to print.
 * A process at MAX_AGENT_DEPTH runs (its spawns are refused by
 * agentDepthRefusal); one deeper than that does not start at all.
 */
export function processAgentDepthRefusal(): string | null {
	if (PROCESS_AGENT_DEPTH <= MAX_AGENT_DEPTH) return null;
	return `[AGENT DEPTH BLOCKED] 8gent did NOT start: this process was started by an agent at depth ${PROCESS_AGENT_DEPTH - 1} (${AGENT_DEPTH_ENV}=${PROCESS_AGENT_DEPTH}) and MAX_AGENT_DEPTH is ${MAX_AGENT_DEPTH}. Do the work in the calling agent instead.`;
}

/** Thrown where a model loop would start in a process deeper than MAX_AGENT_DEPTH. */
export class AgentDepthError extends Error {
	override name = "AgentDepthError";
}

/** Exit code for a refused start: sysexits EX_NOPERM, distinct from a crash (1). */
export const AGENT_DEPTH_EXIT_CODE = 77;
