/**
 * 8gent Code - Sandbox Types
 *
 * Layered sandboxing pattern inspired by Unikraft micro-VMs
 * (https://github.com/unikraft/unikraft) — sub-50ms boot insight
 * abstracted into process/tempdir/docker isolation layers.
 */

/** Isolation level, ordered from weakest to strongest */
export type IsolationLevel = "process" | "tempdir" | "seatbelt" | "docker" | "microvm";

/** Options for a sandboxed execution */
export interface SandboxOptions {
	/** Timeout in ms. Default: 30000 */
	timeout?: number;
	/** Force a specific isolation level. Default: auto-detect best available */
	isolation?: IsolationLevel;
	/** Allow network access inside sandbox. Default: false */
	allowNetwork?: boolean;
	/** Working directory inside sandbox. Default: auto-created temp dir */
	workDir?: string;
	/** Extra environment variables to inject. All others are stripped. */
	env?: Record<string, string>;
	/**
	 * Session id. When set and workDir is not, the run uses the session's
	 * persistent scratch dir (shared across calls, destroyed with the
	 * session) instead of a throwaway per-run temp dir.
	 */
	sessionId?: string;
	/** Extra read-only paths (seatbelt layer; manifest read scopes). */
	readPaths?: string[];
	/** Extra read/write paths (seatbelt layer; manifest write scopes). */
	writePaths?: string[];
}

/** Result from a sandboxed execution */
export interface SandboxResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut: boolean;
	isolation: IsolationLevel;
	durationMs: number;
}
