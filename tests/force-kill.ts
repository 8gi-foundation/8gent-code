/**
 * Hard-kill a process from a second process, the way a daemon dies with no
 * shutdown hook (#4113).
 *
 * POSIX: `kill -KILL <pid>`. Windows has no signals, so the kill is
 * `Stop-Process -Force` (TerminateProcess), the same call the Scheduled Task
 * stop path uses (packages/daemon/service.ts, stopTaskScript). Either way the
 * killer is its own process, so the child gets no chance to run any code.
 */
import { existsSync } from "node:fs";
import type { Subprocess } from "bun";

export async function forceKillFromSecondProcess(pid: number): Promise<void> {
	// kill -KILL -1 kills every process this user owns; 0 kills the process group.
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		throw new Error(`forceKillFromSecondProcess: refusing pid ${pid}, expected a positive integer`);
	}
	const cmd =
		process.platform === "win32"
			? [
					"powershell.exe",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`Stop-Process -Id ${pid} -Force`,
				]
			: ["kill", "-KILL", String(pid)];
	const killer = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
	const code = await killer.exited;
	if (code !== 0) {
		const err = await new Response(killer.stderr).text();
		throw new Error(`${cmd[0]} exited ${code} killing pid ${pid}: ${err.trim()}`);
	}
}

/** True while `pid` names a live process. Signal 0 only probes; it works on Windows too. */
export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Wait until the child writes `file`. Fails fast, with the child's stderr, if
 * the child exits first, so a broken child script never looks like a timeout.
 */
export async function waitForFile(
	file: string,
	proc: Subprocess<"ignore", "ignore" | "pipe", "pipe">,
	timeoutMs = 30_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let exited = false;
	void proc.exited.then(() => {
		exited = true;
	});
	while (!existsSync(file)) {
		if (exited) {
			const err = await new Response(proc.stderr).text();
			throw new Error(`child exited (${proc.exitCode}) before writing ${file}: ${err.trim()}`);
		}
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
		await Bun.sleep(25);
	}
}
