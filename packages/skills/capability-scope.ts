/**
 * 8gent Code - Skill Capability Scoping (issue #2760, Step 2)
 *
 * Step 1 gave a skill a declared, validated manifest (capabilities, models,
 * entry points). Step 2 makes that declaration load-bearing at runtime: a skill
 * gets what it declares, nothing more. This module is the bridge between the
 * skill's manifest capabilities (abstract: "network", "filesystem-write") and
 * the policy engine's per-tool capability manifests (NemoClaw v2,
 * packages/permissions/capability-manifest.ts), which check concrete requests
 * (fs_read of a path, network to a host, exec of a command).
 *
 * Enforcement is a two-gate AND:
 *   1. Skill envelope gate (this module) - the request's capability must be one
 *      the skill declared. A skill that never declared "network" cannot reach
 *      the network even through a tool whose own manifest allows it.
 *   2. Tool manifest gate (enforceCapability) - the concrete path/host/command
 *      must be inside the tool's declared least-capability scopes.
 *
 * Backward compatibility: enforcement is opt-in by declaration. A skill that
 * declares NO capabilities (every bundled skill today) has an EMPTY envelope and
 * is treated as unscoped/legacy - only the tool manifest gate applies, so
 * existing behavior is unchanged. A skill that declares at least one capability
 * opts into strict scoping. The registry (Step 3) and quarantine lane (Step 4)
 * build on this by requiring third-party skills to declare, so an installed
 * stranger's skill is always scoped.
 *
 * Pure and IO-free apart from the tool-manifest gate's own path resolution, so
 * it runs identically in the agent loop, the daemon, and unit tests.
 */

import {
	type CapabilityRequest,
	type EnforceOptions,
	enforceCapability,
} from "../permissions/capability-manifest.js";
import type { PolicyDecision } from "../permissions/types.js";
import type { Skill } from "./index.js";

// ============================================
// Request -> skill capability mapping
// ============================================

/**
 * Map a concrete policy-engine capability request to the abstract skill-manifest
 * capability token it consumes. These four kinds are the capabilities a tool can
 * exercise today; the tokens are members of KNOWN_CAPABILITIES in manifest.ts.
 */
const REQUEST_TO_CAPABILITY: Record<CapabilityRequest["kind"], string> = {
	fs_read: "filesystem-read",
	fs_write: "filesystem-write",
	network: "network",
	exec: "shell",
};

/** The skill-manifest capability token a given request kind consumes. */
export function capabilityForRequest(kind: CapabilityRequest["kind"]): string {
	return REQUEST_TO_CAPABILITY[kind];
}

// ============================================
// Envelope
// ============================================

/**
 * The set of capabilities a skill declared it touches: the union of what it
 * requires (must be present) and what it grants (widens the active set with).
 * Both are the skill's own declarations of the capabilities in its world, so
 * both bound what it may reach.
 */
export function skillEnvelope(skill: Skill): Set<string> {
	return new Set([...skill.requiredCapabilities, ...skill.grantedCapabilities]);
}

/**
 * A skill is scoped when it declared at least one capability. An unscoped skill
 * (no declarations) is legacy/trusted and only the tool manifest gate applies,
 * preserving backward compatibility for every bundled skill.
 */
export function isSkillScoped(skill: Skill): boolean {
	return skillEnvelope(skill).size > 0;
}

// ============================================
// Enforcement
// ============================================

/**
 * Enforce a skill's declared capability envelope over a tool call, then defer to
 * the policy engine's tool-manifest gate. Both must allow. A scoped skill that
 * did not declare the requested capability is denied here before the tool
 * manifest is even consulted - "a skill gets what it declares, nothing more".
 */
export function enforceSkillScope(
	skill: Skill,
	toolName: string,
	request: CapabilityRequest,
	opts: EnforceOptions = {},
): PolicyDecision {
	if (isSkillScoped(skill)) {
		const needed = REQUEST_TO_CAPABILITY[request.kind];
		if (!skillEnvelope(skill).has(needed)) {
			return {
				allowed: false,
				reason: `[skill-scope] "${skill.name}" declared no "${needed}" capability; ${request.kind} denied (a skill gets what it declares, nothing more)`,
			};
		}
	}
	// Tool-manifest gate underneath: the concrete request must be inside the
	// tool's least-capability scopes. Deny by default for unmanifested tools.
	return enforceCapability(toolName, request, opts);
}
