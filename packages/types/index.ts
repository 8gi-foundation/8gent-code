/**
 * 8gent Code - Core Type Definitions
 */

export * from "./tool-result.js";

// ============================================
// Tool System
// ============================================

export type Permission =
	| "read:code"
	| "write:code"
	| "read:fs"
	| "write:fs"
	| "exec:shell"
	| "net:fetch"
	| "net:listen"
	| "github:read"
	| "github:write";

/**
 * Tool capability tier — coarse classification of what a tool can do.
 *
 * Used as the primary gate before invocation. A user (or session) is granted
 * a set of tiers; a tool may declare one or more required tiers and only
 * runs if every required tier is in the grant.
 *
 * - read       — observe local state (filesystem, git, AST). No mutation.
 * - write      — mutate local state (write files, edit, scaffold, commit).
 * - execute    — run shell commands or arbitrary processes.
 * - network    — reach external services (HTTP fetch, GitHub API, push, etc).
 * - admin      — privileged ops affecting auth, secrets, identity, registry.
 * - dangerous  — irreversible or destructive (force-push, rm -rf, etc).
 *
 * A tool with multi-tier reach declares ALL of its tiers, e.g. `git_push`
 * needs `["execute", "network"]`; a destructive shell command needs
 * `["execute", "dangerous"]`.
 */
export type ToolCapabilityTier =
	| "read"
	| "write"
	| "execute"
	| "network"
	| "admin"
	| "dangerous";

export type Capability =
	| "code"
	| "code.symbol"
	| "code.ast"
	| "code.diagnostics"
	| "design"
	| "design.component"
	| "design.animation"
	| "workflow"
	| "repo"
	| "repo.graph"
	| "github"
	| "execution";

export interface JSONSchema {
	type: string;
	properties?: Record<string, JSONSchema>;
	required?: string[];
	items?: JSONSchema;
	description?: string;
}

export interface Tool {
	name: string;
	description: string;
	capabilities: Capability[];
	inputSchema: JSONSchema;
	outputSchema: JSONSchema;
	permissions: Permission[];
	/**
	 * Capability tiers required to invoke this tool. Must declare at least one.
	 * The compiler refuses tool registration if this field is missing.
	 */
	tiers: [ToolCapabilityTier, ...ToolCapabilityTier[]];
	execute: (input: unknown, context: ExecutionContext) => Promise<unknown>;
}

export interface ToolRegistration {
	name: string;
	description: string;
	capabilities: Capability[];
	inputSchema: JSONSchema;
	outputSchema?: JSONSchema;
	permissions: Permission[];
	/**
	 * Capability tiers required to invoke this tool. Must declare at least one.
	 * Required at registration time — TypeScript will refuse to compile a tool
	 * that omits its tiers.
	 */
	tiers: [ToolCapabilityTier, ...ToolCapabilityTier[]];
}

/**
 * Result of a capability-tier check before a tool invocation.
 */
export interface CapabilityCheckResult {
	allowed: boolean;
	missing: ToolCapabilityTier[];
}

/**
 * Structured response returned when a tool invocation is denied because
 * the caller lacks the required capability tier(s).
 *
 * Surfaced through `ToolResult` so callers (LLM agents, RPC clients,
 * test harnesses) can branch on `denied: "capability"` without parsing
 * free-form error strings.
 */
export interface CapabilityDenial {
	denied: "capability";
	tool: string;
	required: ToolCapabilityTier[];
	missing: ToolCapabilityTier[];
	granted: ToolCapabilityTier[];
	message: string;
}

// ============================================
// Execution Context
// ============================================

export interface ExecutionContext {
	sessionId: string;
	workingDirectory: string;
	permissions: Permission[];
	sandbox: SandboxConfig;
	/**
	 * Capability tiers granted to this session. Tools whose required tiers
	 * are not all present are denied before invocation. When omitted, the
	 * executor falls back to the registered default grant.
	 */
	grantedTiers?: ToolCapabilityTier[];
}

export interface SandboxConfig {
	type: "container" | "runtime" | "none";
	allowedPaths: string[];
	networkAccess: boolean;
	timeout: number;
}

// ============================================
// AST Index
// ============================================

export type SymbolKind =
	| "function"
	| "method"
	| "class"
	| "type"
	| "interface"
	| "constant"
	| "variable"
	| "module";

export interface Symbol {
	id: string; // e.g., "src/utils/index.ts::parseDate"
	name: string;
	kind: SymbolKind;
	filePath: string;
	startLine: number;
	endLine: number;
	signature?: string;
	docstring?: string;
	summary?: string;
}

export interface FileOutline {
	filePath: string;
	language: string;
	symbols: Symbol[];
}

export interface RepoIndex {
	id: string;
	sourceRoot: string;
	indexedAt: string;
	fileCount: number;
	symbolCount: number;
	languages: Record<string, number>;
}

// ============================================
// Planner
// ============================================

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";

export interface Task {
	id: string;
	subject: string;
	description: string;
	status: TaskStatus;
	dependencies: string[];
	blockedBy: string[];
	output?: unknown;
}

export interface Plan {
	id: string;
	goal: string;
	tasks: Task[];
	createdAt: string;
	status: "planning" | "executing" | "completed" | "failed";
}

// ============================================
// Workflow
// ============================================

export interface WorkflowStep {
	id: string;
	tool: string;
	input: Record<string, unknown>;
	condition?: string;
	onSuccess?: string;
	onFailure?: string;
}

export interface Workflow {
	id: string;
	name: string;
	description: string;
	trigger: "manual" | "event" | "schedule";
	steps: WorkflowStep[];
}

// ============================================
// Primitives
// ============================================

export interface Primitive {
	id: string;
	type: "component" | "animation" | "workflow" | "schema";
	name: string;
	description: string;
	source: string; // File path or URL
	tags: string[];
	usage: string; // Example usage
}

export interface PrimitiveRegistry {
	primitives: Primitive[];
	version: string;
	lastUpdated: string;
}

// ============================================
// GitHub Intelligence
// ============================================

export interface GitHubSymbol extends Symbol {
	repo: string;
	stars: number;
	lastCommit: string;
}

export interface GitHubQuery {
	query: string;
	language?: string;
	minStars?: number;
	limit?: number;
}

export interface DependencyGraph {
	root: string;
	dependencies: Record<string, string[]>;
	devDependencies: Record<string, string[]>;
}
