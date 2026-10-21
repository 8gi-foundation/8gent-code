// Imported first by apps/tui/src/index.tsx (#4682). On Termux the launcher
// starts this process without LD_PRELOAD (bin/termux-exec.js says why: a
// fork()ed child running termux-exec's execve wrapper can wait forever on a
// lock copied held from another thread, and uv_spawn then blocks this thread).
// Here the variable goes back into env so every child still gets termux-exec,
// and processes started straight from this one run through /system/bin/sh,
// whose exec does what termux-exec would have done (shebangs, system linker).
import type * as ChildProcessModule from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import {
	PRELOAD_CARRY,
	isTermux,
	restorePreload,
	shellWrappedSpawn,
} from "../../../../bin/termux-exec.js";

type CP = typeof ChildProcessModule;
type SpawnOptions = { file: string; args: string[]; envPairs?: string[] };
type SyncOptions = { env?: NodeJS.ProcessEnv; shell?: unknown } | undefined;

function pathFromPairs(pairs: string[] | undefined): string | undefined {
	const pair = pairs?.find((p) => p.startsWith("PATH="));
	return pair ? pair.slice(5) : process.env.PATH;
}

/** Wrap a sync spawn-like export (spawnSync, execFileSync). Exported for tests. */
export function wrapSyncSpawn<F extends (...a: never[]) => unknown>(original: F): F {
	const call = original as unknown as (...a: unknown[]) => unknown;
	const wrapped = function (this: unknown, ...callArgs: unknown[]) {
		const [file, args, options] = callArgs;
		let argv: string[] = [];
		let opts = options as SyncOptions;
		if (Array.isArray(args)) argv = args as string[];
		else if (args != null && typeof args === "object") opts = args as SyncOptions;
		const w =
			opts?.shell || typeof file !== "string"
				? null
				: shellWrappedSpawn(file, [file, ...argv], (opts?.env ?? process.env).PATH);
		if (!w) return call.apply(this, callArgs);
		return call.call(this, w.file, w.args.slice(1), opts);
	};
	return wrapped as unknown as F;
}

/** Patch child_process on the CJS exports object `cp`. Exported for tests. */
export function patchChildProcess(cp: CP): void {
	const proto = cp.ChildProcess.prototype as unknown as {
		spawn: (options: SpawnOptions) => unknown;
	};
	const spawn = proto.spawn;
	proto.spawn = function (this: unknown, options: SpawnOptions) {
		const w =
			options &&
			shellWrappedSpawn(
				options.file,
				options.args ?? [options.file],
				pathFromPairs(options.envPairs),
			);
		if (w) options = { ...options, file: w.file, args: w.args };
		return spawn.call(this, options);
	};
	const mutable = cp as unknown as Record<string, unknown>;
	mutable.spawnSync = wrapSyncSpawn(cp.spawnSync);
	mutable.execFileSync = wrapSyncSpawn(cp.execFileSync);
}

/** Restore LD_PRELOAD and route direct spawns through sh. Returns true if applied. */
export function installTermuxHandoff(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	// Only on Termux. Anywhere else a carried value is dropped, never turned into
	// LD_PRELOAD for this process's children (8SO read of #4683).
	if (!isTermux(env, platform)) {
		delete env[PRELOAD_CARRY];
		return false;
	}
	if (!restorePreload(env)) return false;
	try {
		const cp = createRequire(import.meta.url)("node:child_process") as CP;
		patchChildProcess(cp);
		syncBuiltinESMExports();
	} catch {
		// LD_PRELOAD is back in env either way; the TUI must still start.
	}
	return true;
}

installTermuxHandoff();
