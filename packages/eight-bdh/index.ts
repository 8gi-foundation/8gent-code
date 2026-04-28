/**
 * @8gent/eight-bdh - Public surface for the 8gent 0.1 BDH orchestrator.
 *
 * Spec: docs/specs/8GENT-0.1-BDH-ORCHESTRATOR.md (§3.4 decide, §3.6 loadOrchestrator).
 * All shapes come from ./types - do not redefine.
 */

import type {
	OrchestratorInput,
	Decision,
	AuditTrace,
} from "./types";

export * from "./types";
export { LocalClient, VesselClient, type InferenceClient } from "./client";
export { decode, extractTrace } from "./decode";

export type ModuleId = string;

export interface OrchestratorHandle {
	base: string;
	modules: ModuleId[];
	decide(input: OrchestratorInput): Promise<{
		decision: Decision;
		trace: AuditTrace;
	}>;
}

export interface LoadOrchestratorOptions {
	base: "8gent-0.1.0-bdh-r:10m";
	modules?: ModuleId[];
}

export async function decide(
	_input: OrchestratorInput,
): Promise<{ decision: Decision; trace: AuditTrace }> {
	// TODO(james): wire to LocalClient / VesselClient once Phase 0 weights exist.
	throw new Error(
		"@8gent/eight-bdh decide() not implemented yet - Phase 0. Train weights first, then wire LocalClient.",
	);
}

export async function loadOrchestrator(
	_opts: LoadOrchestratorOptions,
): Promise<OrchestratorHandle> {
	// TODO(james): module concatenation lands in Phase 4. Stub keeps the surface visible.
	throw new Error(
		"@8gent/eight-bdh loadOrchestrator() not implemented yet - Phase 0. Module concatenation is a Phase 4 deliverable.",
	);
}
