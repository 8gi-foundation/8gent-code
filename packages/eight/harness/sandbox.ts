/**
 * Sandboxed Tool Execution
 *
 * Provides a uniform `execute(name, input) -> Promise<string>` interface.
 * The sandbox never receives credentials directly. The Vault injects them
 * at the boundary before the tool handler runs.
 *
 * Tools are registered as simple async functions: (input) -> string.
 * This makes the sandbox replaceable: swap in a Docker executor, WASM runner,
 * or remote RPC target without changing the harness.
 *
 * Issue: #1403
 */

import type { CredentialVault, Sandbox, ToolHandler } from "./types";

/** Create a sandboxed tool executor. */
export function createSandbox(vault?: CredentialVault): Sandbox {
	const tools = new Map<string, ToolHandler>();

	const sandbox: Sandbox = {
		async execute(
			name: string,
			input: Record<string, unknown>,
		): Promise<string> {
			const handler = tools.get(name);
			if (!handler) {
				throw new Error(
					`Unknown tool: ${name}. Available: ${Array.from(tools.keys()).join(", ")}`,
				);
			}

			// Vault injection: replace $VAULT{KEY} sentinels with actual credentials.
			// The tool handler never sees the vault or knows credentials exist.
			const resolvedInput = vault ? vault.inject(input) : { ...input };

			try {
				return await handler(resolvedInput);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`Tool "${name}" failed: ${message}`);
			}
		},

		listTools(): string[] {
			return Array.from(tools.keys()).sort();
		},
	};

	return Object.assign(sandbox, {
		/** Register a tool handler. */
		register(name: string, handler: ToolHandler): void {
			tools.set(name, handler);
		},

		/** Remove a tool handler. */
		unregister(name: string): boolean {
			return tools.delete(name);
		},

		/** Check if a tool is registered. */
		hasTools(name: string): boolean {
			return tools.has(name);
		},
	});
}

/** Sandbox with registration methods exposed. */
export type MutableSandbox = Sandbox & {
	register(name: string, handler: ToolHandler): void;
	unregister(name: string): boolean;
	hasTools(name: string): boolean;
};
