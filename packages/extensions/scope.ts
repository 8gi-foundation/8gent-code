/**
 * 8gent Code - Revertible extension scope (#3431)
 *
 * Every tool, listener or deferred undo an extension registers through its
 * scope is recorded with its undo. Hooks are not part of the scope yet:
 * HookManager persists them to disk, so they wait for in-memory registration.
 * dispose() runs the undos newest first; one that throws is
 * reported and the rest still run. Once dispose() starts, every further
 * registration is refused. Behind EIGHT_EXT_SCOPE=1, default off.
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
	/** Run every undo, newest first, and refuse later registrations. Safe to call twice. */
	dispose(): Promise<{ errors: string[] }>;
}

export function scopeEnabled(): boolean {
	return process.env.EIGHT_EXT_SCOPE === "1";
}

export function createScope(name: string): ExtensionScope {
	const undos: Array<() => unknown> = [];
	const tools: Record<string, Function> = Object.create(null);
	let disposed = false;
	const open = (what: string) => {
		if (disposed) throw new Error(`[ext] ${name}: scope disposed, ${what} refused`);
	};

	const scope: ExtensionScope = {
		name,
		tools,
		tool(toolName, fn) {
			open(`tool ${toolName}`);
			if (!/^[\w-]+$/.test(toolName) || toolName === "__proto__") {
				throw new Error(`[ext] ${name}: invalid tool name ${JSON.stringify(toolName)}`);
			}
			tools[toolName] = fn;
			undos.push(() => delete tools[toolName]);
		},
		listen(emitter, event, fn) {
			open(`listener ${event}`);
			const off = emitter.off ?? emitter.removeListener;
			if (typeof off !== "function") {
				throw new Error(`[ext] ${name}: emitter has no off/removeListener, cannot undo ${event}`);
			}
			emitter.on(event, fn);
			undos.push(() => off.call(emitter, event, fn));
		},
		defer(undo) {
			open("defer");
			undos.push(undo);
		},
		async dispose() {
			disposed = true;
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
