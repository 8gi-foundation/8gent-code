/**
 * bash-tool.ts - integration shim for issue #2466
 *
 * Parses any bash command via parseBash, lifts every segment + redirection +
 * subshell into a BashCapability, and evaluates the vector against the policy
 * engine BEFORE spawning. If any capability is denied, the whole command is
 * blocked - even if the literal command string would have been allowed by the
 * legacy single-string check.
 *
 * Spawn is intentionally left to the caller (the existing bash actuator). This
 * module exposes only the gate.
 */

import { parseBash, toCapabilities, type BashCapability } from "./bash-parser";
import { evaluateCapabilities } from "../permissions/policy-engine";
import type { PolicyDecision } from "../permissions/types";

export interface BashGateResult {
	decision: PolicyDecision;
	capabilities: BashCapability[];
}

/**
 * Gate a raw bash command string against the policy engine.
 *
 * Returns the decision and the capabilities that were evaluated, so callers
 * can log or display the per-segment trace alongside the deny reason.
 */
export function gateBashCommand(command: string, agentId?: string): BashGateResult {
	const parsed = parseBash(command);
	const capabilities = toCapabilities(parsed);

	if (capabilities.length === 0) {
		// Empty / whitespace-only command - allow (caller will no-op spawn)
		return { decision: { allowed: true }, capabilities };
	}

	const decision = evaluateCapabilities(capabilities, agentId);
	return { decision, capabilities };
}

export { parseBash, toCapabilities } from "./bash-parser";
export type { BashCapability, BashParseResult, CommandSegment, Redirection } from "./bash-parser";
