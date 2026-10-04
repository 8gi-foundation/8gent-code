/**
 * 8gent Code - Revertible extension scope (#3431)
 *
 * Every registration an extension makes through its scope is recorded with
 * its undo. dispose() runs the undos newest first; one that throws is
 * reported and the rest still run. Behind EIGHT_EXT_SCOPE=1, default off.
 */

/** Structural match for HookManager.registerHook / unregisterHook. */
export interface HookRegistry {
	registerHook(cfg: never): { id: string };
	unregisterHook(id: string): boolean;
}

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
	/** Register a hook config with the hook registry. */
	hook(cfg: Record<string, unknown>): void;
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

export function createScope(name: string, hooks?: HookRegistry): ExtensionScope {
	const undos: Array<() => unknown> = [];
	const tools: Record<string, Function> = {};

	const scope: ExtensionScope = {
		name,
		tools,
		tool(toolName, fn) {
			tools[toolName] = fn;
			undos.push(() => delete tools[toolName]);
		},
		hook(cfg) {
			if (!hooks) throw new Error(`[ext] ${name}: no hook registry`);
			const { id } = hooks.registerHook(cfg as never);
			undos.push(() => hooks.unregisterHook(id));
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
