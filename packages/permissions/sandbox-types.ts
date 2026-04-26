/**
 * 8gent Code - Sandbox Types
 *
 * Layered sandboxing pattern inspired by Unikraft micro-VMs
 * (https://github.com/unikraft/unikraft) — sub-50ms boot insight
 * abstracted into process/tempdir/docker isolation layers.
 */

/** Isolation level, ordered from weakest to strongest */
export type IsolationLevel = "process" | "tempdir" | "docker" | "microvm";

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
