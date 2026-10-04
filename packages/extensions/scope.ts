/**
 * 8gent Code - Revertible extension scope (#3431)
 *
 * Every tool, listener or deferred undo an extension registers through its
 * scope is recorded with its undo. Hooks are not part of the scope yet:
 * HookManager persists them to disk, so they wait for in-memory registration.
 * dispose() runs the undos newest first; one that throws is
 * reported and the rest still run. Behind EIGHT_EXT_SCOPE=1, default off.
 */

interface Emitter {
	on(event: string, fn: (...args: unknown[]) => void): unknown;
	off?(event: string, fn: (...args: unknown[]) => void): unknown;
	removeListener?(event: string, fn: (...args: unknown[]) => void): unknown;
}

export interface ExtensionScope {
	readonly name: string;
	readonly tools: Record<string, Function>;
	/** Register a tool, exposed as `<extension>:<name>`. */
	tool(name: string, fn: Function): void;
	/** Subscribe to an emitter; unsubscribed on dispose. */
	listen(emitter: Emitter, event: string, fn: (...args: unknown[]) => void): void;
	/** Record any other undo (timers, sockets). */
	defer(undo: () => unknown): void;
	/** Run every undo, newest first. Safe to call twice. */
	dispose(): Promise<{ errors: string[] }>;
}

export function scopeEnabled(): boolean {
	return process.env.EIGHT_EXT_SCOPE === "1";
}

export function createScope(name: string): ExtensionScope {
	const undos: Array<() => unknown> = [];
	const tools: Record<string, Function> = {};

	const scope: ExtensionScope = {
		name,
		tools,
		tool(toolName, fn) {
			tools[toolName] = fn;
			undos.push(() => delete tools[toolName]);
		},
		listen(emitter, event, fn) {
			emitter.on(event, fn);
			undos.push(() => (emitter.off ?? emitter.removeListener)?.call(emitter, event, fn));
		},
		defer(undo) {
			undos.push(undo);
		},
		async dispose() {
			const errors: string[] = [];
			while (undos.length) {
				const undo = undos.pop() as () => unknown;
				try {
					await undo();
				} catch (err) {
					errors.push(`[ext] ${name}: undo failed: ${err instanceof Error ? err.message : err}`);
				}
			}
			return { errors };
		},
	};
	return scope;
}
