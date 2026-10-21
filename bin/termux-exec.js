// Termux handoff (#4682). Pure helpers so the launcher (bin/8gent-run.js),
// bin/8gent.ts and the TUI share one rule, and a test can feed them inputs.
//
// Why: on Termux, LD_PRELOAD=libtermux-exec.so wraps execve. libuv starts a
// child with fork() and the child calls execvp(); with the library preloaded,
// that call runs termux-exec's execve wrapper inside the forked child of a
// many-threaded process (allocation, file reads, path work). A lock held by
// another thread at fork time is copied held, the child waits on it forever
// before it ever reaches execve, and uv_spawn blocks the TUI's main thread on
// its exec-status pipe. So the TUI process starts without the library mapped,
// carries the value in EIGHT_TERMUX_LD_PRELOAD, and puts it back in its own
// env so every process it starts still gets termux-exec.
import { existsSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";

export const PRELOAD_CARRY = "EIGHT_TERMUX_LD_PRELOAD";
/** Set to 1 to keep LD_PRELOAD in the TUI process (escape hatch). */
export const KEEP_PRELOAD = "EIGHT_TERMUX_KEEP_PRELOAD";

export function isTermux(env = process.env, platform = process.platform) {
	return platform === "android" || String(env.PREFIX ?? "").includes("/com.termux/");
}

/**
 * The env to start the TUI process with: LD_PRELOAD moved to PRELOAD_CARRY on
 * Termux, the same object everywhere else.
 */
export function tuiProcessEnv(env, platform = process.platform) {
	if (!isTermux(env, platform) || !env.LD_PRELOAD || env[KEEP_PRELOAD] === "1") return env;
	const { LD_PRELOAD, ...rest } = env;
	return { ...rest, [PRELOAD_CARRY]: LD_PRELOAD };
}

/**
 * Inside the TUI: put LD_PRELOAD back in env (mutated) so child processes get
 * termux-exec. The library is not mapped into this process; only the variable
 * returns. Returns true when a handoff happened.
 */
export function restorePreload(env = process.env) {
	const carried = env[PRELOAD_CARRY];
	if (!carried) return false;
	delete env[PRELOAD_CARRY];
	if (!env.LD_PRELOAD) env.LD_PRELOAD = carried;
	return true;
}

const LINKER = /^linker(64)?$/;

/**
 * An absolute path to node. Started through Android's system linker,
 * process.execPath is /system/bin/linker64, and running that with node flags
 * prints `error: expected absolute path: "--experimental-sqlite"`.
 */
export function nodeExecPath(execPath = process.execPath, env = process.env, exists = existsSync) {
	if (!LINKER.test(basename(execPath))) return execPath;
	const self = env.TERMUX_EXEC__PROC_SELF_EXE;
	if (self && isAbsolute(self) && !LINKER.test(basename(self)) && exists(self)) return self;
	if (env.PREFIX) {
		const prefixed = join(env.PREFIX, "bin", "node");
		if (exists(prefixed)) return prefixed;
	}
	return "node";
}

const SYSTEM_DIRS = ["/system/", "/apex/", "/vendor/", "/product/", "/odm/"];

function resolveOnPath(file, pathVar, exists) {
	if (file.includes("/")) return isAbsolute(file) && exists(file) ? file : null;
	for (const dir of String(pathVar ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, file);
		if (exists(candidate)) return candidate;
	}
	return null;
}

/**
 * How the TUI (no termux-exec mapped) starts `file`. A program in Termux's own
 * tree may be a script with a `#!/usr/bin/env` line or need the system linker,
 * which termux-exec handles, so it runs as `/system/bin/sh -c 'exec "$0" "$@"'`:
 * sh is a system binary, gets LD_PRELOAD from env, and its exec goes through
 * termux-exec in a fresh single-threaded process. System binaries, and names
 * not found on PATH (so ENOENT still surfaces), are left alone. Returns null
 * when nothing changes, else { file, args } with args[0] as argv0.
 */
export function shellWrappedSpawn(file, args, pathVar, opts = {}) {
	const exists = opts.exists ?? existsSync;
	const execPath = opts.execPath ?? process.execPath;
	const env = opts.env ?? process.env;
	if (typeof file !== "string" || !file) return null;
	let target = file;
	// The TUI's own node, when process.execPath is the system linker.
	if (file === execPath && LINKER.test(basename(file))) {
		const node = nodeExecPath(execPath, env, exists);
		if (node === file) return null;
		target = node;
	}
	const resolved = resolveOnPath(target, pathVar, exists);
	if (!resolved) return target === file ? null : { file: target, args: [target, ...args.slice(1)] };
	if (SYSTEM_DIRS.some((d) => resolved.startsWith(d))) return null;
	return {
		file: "/system/bin/sh",
		args: ["/system/bin/sh", "-c", 'exec "$0" "$@"', resolved, ...args.slice(1)],
	};
}
