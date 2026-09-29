/**
 * Run a command string through the platform's shell, and kill what it started.
 *
 * On Windows the shell is cmd.exe, taken from ComSpec. Commands the agent and
 * users write are short POSIX-flavoured lines: `git status && bun test`,
 * `npm run build | tail`, `echo x > file`. cmd.exe runs `&&`, `||`, pipes and
 * redirection the same way and is present on every Windows install. Windows
 * PowerShell 5.1 (the one that ships with Windows) rejects `&&` outright, and
 * a `bash` on PATH is often the WSL launcher in System32, which runs the
 * command inside a Linux VM against a different filesystem.
 *
 * cmd.exe does not parse argv the way the MSVC runtime quotes it, so the
 * command is passed as one verbatim `"..."` token after `/s /c`, which strips
 * exactly the outer quotes. This matches node's own `shell: true` on win32.
 */

import {
	type ChildProcess,
	type ChildProcessWithoutNullStreams,
	type SpawnOptions,
	type StdioPipe,
	type StdioPipeNamed,
	spawnSync,
} from "node:child_process";
import { spawnSafe } from "./win-path";

export type ShellInvocation = {
	file: string;
	args: string[];
	windowsVerbatimArguments: boolean;
};

/** POSIX shell and the flags that precede the command string, e.g. `["bash", "-lc"]`. */
export type PosixShell = readonly [file: string, ...flags: string[]];

export type ShellOptions = {
	platform?: NodeJS.Platform;
	env?: Record<string, string | undefined>;
	posix?: PosixShell;
};

const DEFAULT_POSIX_SHELL: PosixShell = ["sh", "-c"];

export function shellInvocation(command: string, options: ShellOptions = {}): ShellInvocation {
	const { platform = process.platform, env = process.env, posix = DEFAULT_POSIX_SHELL } = options;
	if (platform === "win32") {
		return {
			file: env.ComSpec || env.COMSPEC || "cmd.exe",
			args: ["/d", "/s", "/c", `"${command}"`],
			windowsVerbatimArguments: true,
		};
	}
	const [file, ...flags] = posix;
	return { file, args: [...flags, command], windowsVerbatimArguments: false };
}

export type SpawnShellOptions = Omit<SpawnOptions, "detached" | "shell" | "windowsVerbatimArguments"> & {
	posix?: PosixShell;
	/**
	 * Start the shell as a process-group leader on POSIX so `killProcessTree`
	 * reaches every descendant. It also detaches the tree from the terminal's
	 * Ctrl+C, so only callers that own the timeout and kill should set it.
	 * Windows needs no group: taskkill walks the tree by parent pid.
	 */
	processGroup?: boolean;
};

export function spawnShell(
	command: string,
	options?: SpawnShellOptions & { stdio?: StdioPipeNamed | StdioPipe[] },
): ChildProcessWithoutNullStreams;
export function spawnShell(command: string, options: SpawnShellOptions): ChildProcess;
export function spawnShell(command: string, options: SpawnShellOptions = {}): ChildProcess {
	const { posix, processGroup = false, ...spawnOptions } = options;
	const shell = shellInvocation(command, { posix });
	return spawnSafe(shell.file, shell.args, {
		windowsHide: true,
		...spawnOptions,
		detached: processGroup && process.platform !== "win32",
		windowsVerbatimArguments: shell.windowsVerbatimArguments,
	});
}

export type KillTreeDeps = {
	platform?: NodeJS.Platform;
	kill?: (pid: number, signal: NodeJS.Signals) => void;
	runSync?: (file: string, args: string[]) => void;
};

/**
 * Kill `pid` and everything it spawned. On POSIX this signals the process
 * group (the child must have been spawned as a group leader) and falls back
 * to the single pid. On Windows there are no signals: taskkill /T /F
 * terminates the whole tree.
 */
export function killProcessTree(
	pid: number | undefined,
	signal: NodeJS.Signals = "SIGTERM",
	deps: KillTreeDeps = {},
): void {
	if (!pid || pid <= 0) return;
	const {
		platform = process.platform,
		kill = (p, s) => process.kill(p, s),
		runSync = (file, args) => {
			spawnSync(file, args, { stdio: "ignore", windowsHide: true });
		},
	} = deps;
	if (platform === "win32") {
		runSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
		return;
	}
	try {
		kill(-pid, signal);
		return;
	} catch {
		// Not a group leader, or the group is already gone.
	}
	try {
		kill(pid, signal);
	} catch {
		// Already exited.
	}
}
