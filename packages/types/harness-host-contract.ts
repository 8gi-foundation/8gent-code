/**
 * Harness/Host Contract
 *
 * Strict, typed boundary between the harness runtime (the agent's reasoning
 * loop / sandboxed brain) and the host system (filesystem, network, child
 * processes, memory store, registered tools).
 *
 * The harness CANNOT call host APIs directly. Every host-touching action goes
 * through `validateRequest(contract, request)` first. Anything not declared
 * and granted in the contract is denied at the boundary with a structured
 * error naming the missing capability.
 *
 * Contract surface:
 *   - `Capability` — a single grant of `(category, actions, target allowlist)`
 *   - `HarnessHostContract` — the full set of capabilities a harness was given
 *   - `HostRequest` — what the harness is asking the host to do
 *   - `ContractDecision` — `{ ok: true }` or `{ ok: false, missing, reason }`
 *
 * Issue: #2086
 */

// ---------------------------------------------------------------------------
// Categories & actions
// ---------------------------------------------------------------------------

/** The five capability categories the boundary recognises. */
export type CapabilityCategory =
	| "filesystem"
	| "network"
	| "process"
	| "memory"
	| "tools";

export type FilesystemAction = "read" | "write" | "delete" | "list" | "stat";
export type NetworkAction = "fetch" | "listen" | "resolve";
export type ProcessAction = "spawn" | "kill" | "signal";
export type MemoryAction = "read" | "write" | "delete" | "search";
export type ToolsAction = "execute" | "list";

export type CapabilityAction =
	| FilesystemAction
	| NetworkAction
	| ProcessAction
	| MemoryAction
	| ToolsAction;

// ---------------------------------------------------------------------------
// Capability shapes (one per category)
// ---------------------------------------------------------------------------

/**
 * Allowlist semantics for `targets` in every capability:
 *   - `[]` (empty)        → no targets allowed (capability is structurally
 *                           granted but has zero scope; useful for explicit
 *                           "deny all" entries)
 *   - `["*"]`             → wildcard, any target allowed
 *   - `["foo", "bar/*"]`  → exact match + simple suffix glob (one trailing `*`)
 */
export interface FilesystemCapability {
	category: "filesystem";
	actions: FilesystemAction[];
	/** Path globs (absolute or repo-relative). */
	targets: string[];
}

export interface NetworkCapability {
	category: "network";
	actions: NetworkAction[];
	/** Host allowlist, e.g. `["*.openrouter.ai", "api.github.com"]`. */
	targets: string[];
}

export interface ProcessCapability {
	category: "process";
	actions: ProcessAction[];
	/** Command name allowlist, e.g. `["git", "node", "bun"]`. */
	targets: string[];
}

export interface MemoryCapability {
	category: "memory";
	actions: MemoryAction[];
	/** Memory namespaces the harness may touch, e.g. `["episodic", "semantic"]`. */
	targets: string[];
}

export interface ToolsCapability {
	category: "tools";
	actions: ToolsAction[];
	/** Tool name allowlist, e.g. `["read_file", "edit_file", "shell"]`. */
	targets: string[];
}

/**
 * A single capability grant. Discriminated union over `category`. Named
 * `HarnessCapability` to avoid colliding with the agent-level `Capability`
 * string union already exported from `packages/types/index.ts`.
 */
export type HarnessCapability =
	| FilesystemCapability
	| NetworkCapability
	| ProcessCapability
	| MemoryCapability
	| ToolsCapability;

// ---------------------------------------------------------------------------
// Contract & requests
// ---------------------------------------------------------------------------

/**
 * The capabilities a harness has been granted. Produced at /spawn time by
 * combining the harness flavor's declared requirements with whatever the
 * host policy permits.
 */
export interface HarnessHostContract {
	/** Harness flavor identifier — e.g. "claude", "openclaw", "hermes". */
	flavor: string;
	/**
	 * Capabilities granted to this harness instance. Each entry stands alone;
	 * a request matches if at least one capability covers `(category, action,
	 * target)`.
	 */
	capabilities: HarnessCapability[];
	/** Optional metadata (spawn time, parent session id, etc.) */
	metadata?: Record<string, unknown>;
}

/** A single host-touching action the harness wants to perform. */
export interface HostRequest {
	category: CapabilityCategory;
	action: CapabilityAction;
	/** Path / hostname / command / namespace / tool name. */
	target: string;
	/** Optional structured input for logging / additional checks. */
	input?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type DenialReason =
	| "missing_category"
	| "missing_action"
	| "target_not_allowed";

export interface ContractAllow {
	ok: true;
}

export interface ContractDenial {
	ok: false;
	reason: DenialReason;
	/** Which part of the request was not covered by the contract. */
	missing: {
		category: CapabilityCategory;
		action?: CapabilityAction;
		target?: string;
	};
	/** Human-readable explanation, safe to surface to the harness. */
	message: string;
	/** Harness flavor that issued the request. */
	flavor: string;
}

export type ContractDecision = ContractAllow | ContractDenial;

/** Throwable form of a denial — convenient for boundary code. */
export class ContractViolationError extends Error {
	readonly denial: ContractDenial;
	constructor(denial: ContractDenial) {
		super(denial.message);
		this.name = "ContractViolationError";
		this.denial = denial;
	}
}

// ---------------------------------------------------------------------------
// Flavor declarations
// ---------------------------------------------------------------------------

/**
 * What a harness flavor declares it needs at /spawn time. The host then
 * either grants exactly this (most common), narrows it (per-policy), or
 * refuses to spawn the harness.
 */
export interface HarnessFlavorDeclaration {
	flavor: string;
	/** Short human description. */
	description: string;
	/** Capabilities this flavor needs to function. */
	required: HarnessCapability[];
}
