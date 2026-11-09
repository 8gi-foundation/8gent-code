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
let pruneTimer: ReturnType<typeof setInterval> | undefined;

export interface LiveShellDeps {
	platform?: NodeJS.Platform;
	kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
}

/**
 * Is the process group still there? ESRCH: gone. EPERM: a group exists that is
 * not ours (the pid was reused by someone else), so it is not ours to track.
 */
function groupAlive(pid: number, kill: NonNullable<LiveShellDeps["kill"]>): boolean {
	try {
		kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Drop groups that are gone. Quit only ever signals a process group, and a
 * dead group stays registered for at most one sweep (2 s). Inside that window
 * a new process that got the same pid and made itself a group leader could be
 * signalled; nothing else can.
 */
function prune(deps: LiveShellDeps = {}): void {
	if (process.platform === "win32") return;
	const kill = deps.kill ?? ((p, s) => process.kill(p, s));
	for (const pid of [...live]) if (!groupAlive(pid, kill)) live.delete(pid);
	if (live.size === 0 && pruneTimer) {
		clearInterval(pruneTimer);
		pruneTimer = undefined;
	}
}

export function trackShell(pid: number | undefined): void {
	if (!pid || pid <= 0) return;
	live.add(pid);
	if (!exitHookInstalled) {
		exitHookInstalled = true;
		process.once("exit", () => killLiveShells("SIGKILL"));
	}
	if (!pruneTimer && process.platform !== "win32") {
		pruneTimer = setInterval(() => prune(), 2000);
		pruneTimer.unref();
	}
}

export function untrackShell(pid: number | undefined): void {
	if (pid) live.delete(pid);
}

/**
 * The leader exited. The command is only finished if its whole group is: a
 * background job (`sh -c 'server >/dev/null 2>&1 &'`) or a double-fork daemon
 * stays in the group after the leader closes, and quit must still reach it.
 * Keep the pid registered while the group is alive; the prune sweep removes it
 * once the group is gone.
 *
 * Limit: a process that leaves the group (`setsid -f`, or a daemon that calls
 * setsid itself) is in a new session and group, so no pid we hold names it.
 * There is no portable way to track it without a cgroup or subreaper; it
 * survives quit and that is not hidden.
 */
export function settleShell(pid: number | undefined, deps: LiveShellDeps = {}): void {
	if (!pid) return;
	if (process.platform === "win32") {
		live.delete(pid);
		return;
	}
	const kill = deps.kill ?? ((p, s) => process.kill(p, s));
	if (!groupAlive(pid, kill)) live.delete(pid);
}

/**
 * Signal every live group, and only the group. A pid whose group is gone or is
 * not ours is dropped, never signalled bare: kill(pid) could reach an
 * unrelated process that inherited the number. SIGTERM at quit, SIGKILL from
 * the exit handler.
 */
export function killLiveShells(signal: NodeJS.Signals = "SIGTERM", deps: LiveShellDeps = {}): void {
	const platform = deps.platform ?? process.platform;
	const kill = deps.kill ?? ((p, s) => process.kill(p, s));
	for (const pid of [...live]) {
		if (platform === "win32") {
			killProcessTree(pid, signal);
		} else {
			try {
				kill(-pid, signal);
			} catch {
				live.delete(pid);
				continue;
			}
		}
		if (signal === "SIGKILL") live.delete(pid);
	}
}

/** Live group count, for tests. */
export function liveShellCount(): number {
	return live.size;
}
