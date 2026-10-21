/**
 * safeSpawn - child_process.spawn that cannot take the process down.
 *
 * A bare spawn() of a missing binary emits 'error' on the ChildProcess. With
 * no listener Node rethrows it as an uncaught exception and the whole TUI
 * exits (#4721: /goal on a phone). This attaches the listener before anything
 * can fire and returns a result object instead of throwing. ENOENT, EACCES
 * and a synchronous throw from spawn() all come back as { ok: false }.
 *
 * Fire-and-forget callers ignore the result. Callers that care about a late
 * failure pass onError.
 */

import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";

export type SafeSpawnResult =
	| { ok: true; child: ChildProcess }
	| { ok: false; error: Error; child: null };

export interface SafeSpawnOptions extends SpawnOptions {
	/** Called for an async 'error' (ENOENT arrives here, after spawn returns). */
	onError?: (error: Error) => void;
}

export function safeSpawn(
	command: string,
	args: readonly string[] = [],
	options: SafeSpawnOptions = {},
): SafeSpawnResult {
	const { onError, ...spawnOptions } = options;
	let child: ChildProcess;
	try {
		child = spawn(command, [...args], spawnOptions);
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		try {
			onError?.(error);
		} catch {
			// a throwing callback must not undo the guarantee
		}
		return { ok: false, error, child: null };
	}
	child.on("error", (err) => {
		try {
			onError?.(err);
		} catch {
			// swallow
		}
	});
	return { ok: true, child };
}
