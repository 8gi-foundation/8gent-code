/**
 * @8gent/eight-bdh - Shared type contract.
 *
 * Single source of truth for the data, decision, and audit shapes used
 * across the trainer, the data pipeline scripts, the ontology module,
 * and the runtime client. Importing this file is mandatory; redefining
 * any of these shapes elsewhere is a bug.
 *
 * Spec: docs/specs/8GENT-0.1-BDH-ORCHESTRATOR.md (§3.4, §4.1, §4.4, §7.2)
 */

export type ConceptId = string;

export type DecisionKind =
	| "model"
	| "agent"
	| "tool"
	| "reject"
	| "clarify";

export interface BudgetEnvelope {
	tokens: number;
	ms: number;
}

export interface AuthorityPolicy {
	authority_level: 0 | 1 | 2 | 3 | 4 | 5;
	deny_actions?: string[];
	requires_approval?: boolean;
}

export interface HarnessSnapshot {
	open_files?: string[];
	tools_available?: string[];
	vessels_available?: string[];
	budget_remaining?: BudgetEnvelope;
	history_summary?: string;
}

export interface OrchestratorInput {
	request: string;
	context: HarnessSnapshot;
	policy: AuthorityPolicy;
}

export interface Decision {
	kind: DecisionKind;
	target: string;
	budget: BudgetEnvelope;
	confidence: number;
}

export interface AuditTrace {
	synapseIds: ConceptId[];
	topActivations: { concept: ConceptId; weight: number }[];
	reasoningChain: string[];
	moduleSources?: string[];
}

export interface Provenance {
	source:
		| "replay"
		| "synthetic"
		| "adversarial"
		| "boardroom"
		| "public-bench";
	dataset?: string;
	model_used?: string;
	created_at: string;
	seed?: number;
	notes?: string;
}

export interface TrainingExample {
	id: string;
	state: OrchestratorInput;
	decision: Decision;
	trace: {
		concepts_fired: ConceptId[];
		reasoning: string[];
	};
	provenance: Provenance;
}

export interface DatasetManifest {
	created_at: string;
	count: number;
	splits: { train: number; val: number; test: number };
	source_breakdown: Record<Provenance["source"], number>;
	concept_coverage: Record<ConceptId, number>;
	hash: string;
}

export interface BdhConfig {
	n_layer: number;
	n_embd: number;
	n_head: number;
	mlp_internal_dim_multiplier: number;
	dropout: number;
	vocab_size: number;
}

export const PHASE_0_5M_CONFIG: BdhConfig = {
	n_layer: 6,
	n_embd: 160,
	n_head: 4,
	mlp_internal_dim_multiplier: 64,
	dropout: 0.1,
	vocab_size: 256,
};

export const PHASE_1_10M_CONFIG: BdhConfig = {
	n_layer: 6,
	n_embd: 160,
	n_head: 4,
	mlp_internal_dim_multiplier: 128,
	dropout: 0.1,
	vocab_size: 256,
};
