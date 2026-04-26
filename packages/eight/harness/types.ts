/**
 * Harness Isolation Types
 *
 * Contracts for the brain/hands architecture:
 *   Session  - Append-only JSONL event log (single source of truth)
 *   Harness  - Stateless reasoning loop (reads session, decides, writes back)
 *   Sandbox  - Replaceable execution target (never sees credentials)
 *   Vault    - Credential storage (injects at sandbox boundary)
 *
 * Issues: #1402 (immutable audit logging), #1403 (brain/hands isolation)
 */

// ---------------------------------------------------------------------------
// Audit Entry (JSONL line format)
// ---------------------------------------------------------------------------

/** Every event in the session log has this shape. */
export interface AuditEntry {
	/** Unique entry ID (UUIDv4 prefix) */
	id: string;
	/** ISO-8601 timestamp */
	timestamp: string;
	/** Event classification */
	type: AuditEntryType;
	/** Event-specific data */
	payload: Record<string, unknown>;
	/** SHA-256 hash of the previous entry (genesis entry uses empty string) */
	prevHash: string;
	/** SHA-256 hash of this entry (computed over id + timestamp + type + payload + prevHash) */
	hash: string;
}

export type AuditEntryType =
	| "session_start"
	| "session_end"
	| "tool_call"
	| "tool_result"
	| "decision"
	| "error"
	| "checkpoint";

// ---------------------------------------------------------------------------
// Session (append-only event log)
// ---------------------------------------------------------------------------

/** Append-only JSONL session with SHA-256 checksum chain. */
export interface Session {
	/** Session identifier */
	readonly id: string;
	/** Absolute path to the JSONL file */
	readonly filePath: string;
	/** Append a new entry. Returns the computed hash. */
	append(
		type: AuditEntryType,
		payload: Record<string, unknown>,
	): Promise<string>;
	/** Read all entries from disk (full replay). */
	readAll(): Promise<AuditEntry[]>;
	/** Get the hash of the last entry (for chain verification). */
	lastHash(): Promise<string>;
	/** Verify the entire chain. Returns the first broken entry index, or -1 if valid. */
	verify(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Sandbox (replaceable execution target)
// ---------------------------------------------------------------------------

/** Uniform tool execution interface. Credentials never enter here. */
export interface Sandbox {
	/**
	 * Execute a tool by name with the given input.
	 * The sandbox receives only the tool name and serialized input.
	 * Credentials are injected by the Vault at the boundary, not passed here.
	 */
	execute(name: string, input: Record<string, unknown>): Promise<string>;
	/** List available tool names. */
	listTools(): string[];
}

/** A single tool handler registered with the sandbox. */
export type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

// ---------------------------------------------------------------------------
// Vault (credential storage)
// ---------------------------------------------------------------------------

/** Credential vault. Reads from env/file, never exposes raw secrets to sandbox. */
export interface CredentialVault {
	/** Retrieve a credential by key. Returns undefined if not found. */
	get(key: string): string | undefined;
	/** Check if a credential exists without revealing it. */
	has(key: string): boolean;
	/** List available credential keys (not values). */
	keys(): string[];
	/**
	 * Inject credentials into a tool input object.
	 * Replaces sentinel values like `$VAULT{KEY}` with actual credentials.
	 * Returns a new object (never mutates the original).
	 */
	inject(input: Record<string, unknown>): Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Harness (stateless reasoning loop)
// ---------------------------------------------------------------------------

/** Configuration for the harness loop. */
export interface HarnessConfig {
	/** Session to read from and write to */
	session: Session;
	/** Sandbox for tool execution */
	sandbox: Sandbox;
	/** Credential vault */
	vault: CredentialVault;
	/** Maximum number of tool calls per run (-1 for unlimited) */
	maxSteps: number;
	/** Decide next action given the session history. Returns null to stop. */
	decide: (entries: AuditEntry[]) => Promise<HarnessAction | null>;
}

/** An action the harness should take. */
export interface HarnessAction {
	/** Tool to call */
	tool: string;
	/** Input for the tool */
	input: Record<string, unknown>;
	/** Reasoning that led to this decision */
	reasoning: string;
}

/** Result of a single harness run. */
export interface HarnessRunResult {
	/** Number of steps executed */
	steps: number;
	/** Final session hash */
	finalHash: string;
	/** Whether the run completed normally (decide returned null) */
	completed: boolean;
	/** Error message if the run was interrupted */
	error?: string;
}
