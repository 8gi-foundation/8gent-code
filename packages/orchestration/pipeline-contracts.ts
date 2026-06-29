/**
 * pipeline-contracts.ts - shared types that let the adaptive pipeline's new
 * capabilities (decompose, scaffold, agent-execution, verifiers, Flow events)
 * compose without coupling. Each capability is built as an independent module
 * against THESE types; the pipeline wires them together.
 *
 * Design intent: the adaptive pipeline keeps the part it is best at - the
 * deterministic Obstacle -> Severity -> Decision brain that plans, verifies, and
 * escalates. Heavy execution is delegated to an agentic node (e.g. ornith) that
 * runs its OWN tool loop. Completion models think; the agent node acts.
 */

// ── Decomposition ────────────────────────────────────────────────────────────

export type UnitKind = "config" | "type" | "style" | "component" | "page" | "module" | "other";

/** One model-sized piece of work: a single file a weak model can actually do. */
export interface BuildUnit {
	/** Stable id; conventionally the file path. */
	id: string;
	/** File path relative to the working directory. */
	path: string;
	kind: UnitKind;
	/** Precise spec of what this file must contain / do. */
	spec: string;
	/** Ids of units that must exist before this one (for ordering + context). */
	dependsOn: string[];
}

export interface BuildPlan {
	/** e.g. "next-app", "static-site", "node-cli". */
	projectType: string;
	summary: string;
	units: BuildUnit[];
}

// ── Scaffold ─────────────────────────────────────────────────────────────────

export interface ScaffoldFile {
	path: string;
	content: string;
}

/**
 * The structure the harness GIVES the model so "little instruction" works:
 * boilerplate written up front + a description injected into prompts so the
 * model fills gaps against a known shape instead of architecting from zero.
 */
export interface Scaffold {
	projectType: string;
	/** Boilerplate files written before any engineering begins. */
	files: ScaffoldFile[];
	/** Human/model-readable description of the structure, injected into prompts. */
	structureNote: string;
	/** Optional design tokens / constraints to keep output on-brand. */
	designTokens?: Record<string, string>;
}

// ── Agentic execution node (ornith and friends) ──────────────────────────────

export interface ExecRequest {
	/** What to build, scoped to a single unit. */
	goal: string;
	/** Absolute working directory the agent may write within. */
	workingDirectory: string;
	/** Soft token budget for the agent's whole loop. */
	budgetTokens: number;
	/** Outer-loop abort: the pipeline owns the budget; the agent honors this. */
	signal?: AbortSignal;
	/** Scaffold structureNote + excerpts of dependency files, for grounding. */
	context?: string;
}

export interface ExecResult {
	ok: boolean;
	/** Paths the agent actually wrote (verified against disk by the caller). */
	filesWritten: string[];
	/** Short transcript of what the agent did (tool calls + final note). */
	transcript: string;
	error?: string;
}

/**
 * A node that, given a goal and a working directory, runs its OWN agentic loop
 * (tools + self-correction) and returns what it produced. This is the shape
 * ornith fills: the pipeline hands it a unit; it harnesses itself to deliver.
 */
export interface ExecutorNode {
	/** e.g. "lmstudio:ornith-1.0-9b". */
	key: string;
	kind: "agent";
	run(req: ExecRequest): Promise<ExecResult>;
}

// ── Verifiers (feed the existing Obstacle/Severity machinery) ────────────────

export type VerifierSeverity = "trivial" | "moderate" | "severe";

export interface VerifierFinding {
	/** true = passed, no obstacle. */
	ok: boolean;
	severity: VerifierSeverity;
	/** Stable obstacle type tag, e.g. "missing-file", "compile-error". */
	type: string;
	/** Human-readable detail for logs + the obstacle message. */
	detail: string;
}

export interface VerifyInput {
	workingDirectory: string;
	unit?: BuildUnit;
	/** Optional dev/preview URL for an http-reachability check. */
	url?: string;
}

/** A real, pluggable quality gate. ok=false becomes an Obstacle in the pipeline. */
export interface Verifier {
	name: string;
	verify(input: VerifyInput): Promise<VerifierFinding>;
}

// ── Flow / observability events ──────────────────────────────────────────────

export type PipelineEvent =
	| { kind: "stage"; stage: string; status: "start" | "clear" | "fail"; model?: string; detail?: string }
	| { kind: "unit"; unitId: string; path: string; status: "start" | "done" | "failed"; model?: string }
	| { kind: "obstacle"; stage: string; obstacle: string; severity: VerifierSeverity | string }
	| { kind: "decision"; stage: string; strategy: string; rationale: string }
	| { kind: "escalate"; from: string; to: string; reason: string }
	| { kind: "instruction"; text: string }
	| { kind: "done"; ok: boolean; artifact?: string };

/** A sink the pipeline pushes structured events to (Flow subscribes to these). */
export type PipelineEventSink = (event: PipelineEvent) => void;
