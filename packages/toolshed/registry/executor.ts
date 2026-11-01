/**
 * 8gent Toolshed - Capability-Gated Tool Executor
 *
 * Wraps tool invocation with a tier check. Every tool declares the
 * `ToolCapabilityTier`s it requires; the caller declares which tiers
 * are granted to the current session. The executor refuses to invoke
 * the tool if any required tier is missing, returns a structured
 * `CapabilityDenial`, and writes an audit log entry.
 *
 * This is the single chokepoint — there is no "back door" path that
 * bypasses the check. New code paths that invoke tools should go
 * through `executeTool`.
 */

import type {
	CapabilityCheckResult,
	CapabilityDenial,
	ExecutionContext,
	Tool,
	ToolCapabilityTier,
} from "../../types";
import { recordCapabilityDenial } from "./audit";
import { getTool } from "./register";

/**
 * Default tiers granted when an `ExecutionContext` does not specify
 * `grantedTiers`. Conservative by design — only `read`. Production
 * sessions must opt in to anything beyond observation.
 */
export const DEFAULT_GRANTED_TIERS: ToolCapabilityTier[] = ["read"];

export function checkCapability(
	required: ToolCapabilityTier[],
	granted: ToolCapabilityTier[],
): CapabilityCheckResult {
	const grantSet = new Set(granted);
	const missing = required.filter((t) => !grantSet.has(t));
	return { allowed: missing.length === 0, missing };
}

export function isCapabilityDenial(value: unknown): value is CapabilityDenial {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { denied?: unknown }).denied === "capability"
	);
}

export interface ExecuteToolOptions {
	/** Override the default audit hook (mostly for tests). */
	audit?: (denial: CapabilityDenial, sessionId: string) => void;
}

/**
 * Execute a registered tool, gated by the capability tiers in `context.grantedTiers`.
 *
 * Returns either the tool's normal output, or a `CapabilityDenial` object if
 * the caller's grant does not cover every required tier.
 */
export async function executeTool(
	name: string,
	input: unknown,
	context: ExecutionContext,
	options: ExecuteToolOptions = {},
): Promise<unknown | CapabilityDenial> {
	const tool = getTool(name);
	if (!tool) {
		throw new Error(`[toolshed] Tool not found: ${name}`);
	}

	const granted = context.grantedTiers ?? DEFAULT_GRANTED_TIERS;
	const check = checkCapability(tool.tiers, granted);

	if (!check.allowed) {
		const denial: CapabilityDenial = {
			denied: "capability",
			tool: name,
			required: [...tool.tiers],
			missing: check.missing,
			granted: [...granted],
			message: `Tool '${name}' requires tier(s) [${tool.tiers.join(", ")}] but session was granted [${granted.join(", ") || "(none)"}]. Missing: [${check.missing.join(", ")}].`,
		};

		(options.audit ?? defaultAudit)(denial, context.sessionId);
		return denial;
	}

	return tool.execute(input, context);
}

function defaultAudit(denial: CapabilityDenial, sessionId: string): void {
	recordCapabilityDenial({
		sessionId,
		tool: denial.tool,
		required: denial.required,
		missing: denial.missing,
		granted: denial.granted,
		reason: denial.message,
	});
}

/**
 * Convenience: pre-flight check without executing. Useful for UIs that
 * want to disable a button before the user clicks it.
 */
export function canInvoke(tool: Tool, granted: ToolCapabilityTier[]): boolean {
	return checkCapability(tool.tiers, granted).allowed;
}
