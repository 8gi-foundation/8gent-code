/**
 * The shell commands this process started and has not seen finish.
 *
 * run_command spawns each command as its own process group and unref()s it, so
 * nothing ties its life to the TUI: only a per-command timeout timer ends it,
 * and that timer dies with the process. Quitting (Ctrl+C then process.exit)
 * therefore left a model-started command running with no limit.
 *
 * Every spawn registers its group here. Quit kills the groups politely, and a
 * process "exit" handler kills whatever is left with SIGKILL, which runs
 * synchronously on the way out, so even process.exit(0) cannot orphan one.
 */

import { killProcessTree } from "../core/shell";

const live = new Set<number>();
let exitHookInstalled = false;

export function trackShell(pid: number | undefined): void {
	if (!pid || pid <= 0) return;
	live.add(pid);
	if (!exitHookInstalled) {
		exitHookInstalled = true;
		process.once("exit", () => killLiveShells("SIGKILL"));
	}
}

export function untrackShell(pid: number | undefined): void {
	if (pid) live.delete(pid);
}

/** Signal every live group. SIGTERM at quit, SIGKILL from the exit handler. */
export function killLiveShells(signal: NodeJS.Signals = "SIGTERM"): void {
	for (const pid of [...live]) {
		killProcessTree(pid, signal);
		if (signal === "SIGKILL") live.delete(pid);
	}
}

/** Live group count, for tests. */
export function liveShellCount(): number {
	return live.size;
}
