/**
 * Run a command string through the platform's shell, and kill what it started.
 *
 * On Windows the shell is Git Bash when installed (or settings.shell.path),
 * else PowerShell 7, else cmd.exe from ComSpec (see resolveWindowsShell). Commands the agent and
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
import { existsSync } from "node:fs";
import path from "node:path";
import { loadSettings } from "../settings/store";
import { spawnSafe } from "./win-path";

export type ShellKind = "git-bash" | "powershell" | "cmd";

/** A Windows shell chosen by `resolveWindowsShell`. */
export type ResolvedShell = { kind: ShellKind; file: string };

export type ResolveShellDeps = {
	env?: Record<string, string | undefined>;
	exists?: (p: string) => boolean;
	/** settings.shell.path: an explicit shell to use, taken first when it exists. */
	shellPath?: string;
};

const win = path.win32;

function kindOfPath(file: string): ShellKind {
	const base = win.basename(file).toLowerCase();
	if (/^(bash|sh)(\.exe)?$/.test(base)) return "git-bash";
	if (/^(pwsh|powershell)(\.exe)?$/.test(base)) return "powershell";
	return "cmd";
}

/**
 * Pick the Windows shell: settings.shell.path, then Git Bash, then PowerShell 7
 * (pwsh), then cmd.exe. Windows PowerShell 5.1 is not a fallback: it rejects
 * `&&`, which cmd.exe runs. A `bash` on PATH is skipped on purpose, it is
 * usually the WSL launcher in System32. Git Bash is found under Program Files,
 * LocalAppData, or next to the `git` on PATH.
 */
export function resolveWindowsShell(deps: ResolveShellDeps = {}): ResolvedShell {
	const env = deps.env ?? process.env;
	const exists = deps.exists ?? existsSync;
	const configured = deps.shellPath?.trim();
	if (configured && exists(configured)) return { kind: kindOfPath(configured), file: configured };

	const roots = [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"]].filter((r): r is string => !!r);
	const candidates = roots.flatMap((r) => [win.join(r, "Git", "bin", "bash.exe"), win.join(r, "Git", "usr", "bin", "bash.exe")]);
	if (env.LOCALAPPDATA) candidates.push(win.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
	const pathDirs = (env.Path ?? env.PATH ?? "").split(";").filter(Boolean);
	for (const dir of pathDirs) {
		if (/[\\/]system32$/i.test(dir)) continue; // WSL launcher lives here
		if (exists(win.join(dir, "git.exe"))) {
			// Git\cmd\git.exe or Git\bin\git.exe sit one level under the Git root.
			candidates.push(win.join(dir, "..", "bin", "bash.exe"));
		}
	}
	for (const c of candidates) {
		if (exists(c)) return { kind: "git-bash", file: c };
	}

	for (const dir of pathDirs) {
		const pwsh = win.join(dir, "pwsh.exe");
		if (exists(pwsh)) return { kind: "powershell", file: pwsh };
	}
	for (const r of roots) {
		const pwsh = win.join(r, "PowerShell", "7", "pwsh.exe");
		if (exists(pwsh)) return { kind: "powershell", file: pwsh };
	}
	return { kind: "cmd", file: env.ComSpec || env.COMSPEC || "cmd.exe" };
}

let cachedShell: ResolvedShell | undefined;

/** The shell this process uses on Windows, resolved once. Reads settings.shell.path. */
export function currentWindowsShell(): ResolvedShell {
	if (!cachedShell) {
		let shellPath: string | undefined;
		try {
			shellPath = loadSettings().shell?.path;
		} catch {
			// Settings unreadable: auto-detect.
		}
		cachedShell = resolveWindowsShell({ shellPath });
	}
	return cachedShell;
}

/** Test hook: forget the cached shell. */
export function resetShellCache(): void {
	cachedShell = undefined;
}

/** PowerShell 7 or Windows PowerShell for the optional `powershell` tool. */
export function resolvePowerShell(deps: ResolveShellDeps = {}): ResolvedShell | undefined {
	const env = deps.env ?? process.env;
	const exists = deps.exists ?? existsSync;
	const pathDirs = (env.Path ?? env.PATH ?? "").split(";").filter(Boolean);
	const roots = [env.ProgramFiles, env.ProgramW6432].filter((r): r is string => !!r);
	const candidates = [
		...pathDirs.map((d) => win.join(d, "pwsh.exe")),
		...roots.map((r) => win.join(r, "PowerShell", "7", "pwsh.exe")),
		...(env.SystemRoot ? [win.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")] : []),
	];
	const file = candidates.find((c) => exists(c));
	return file ? { kind: "powershell", file } : undefined;
}

/** Plain words for the model and for logs. */
export function describeShell(shell: ResolvedShell | "posix", platform: NodeJS.Platform = process.platform): string {
	if (shell === "posix") return platform === "win32" ? "sh" : "sh (POSIX)";
	if (shell.kind === "git-bash") return "Git Bash";
	if (shell.kind === "powershell") return "PowerShell";
	return "cmd.exe";
}

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
	/** Windows only: run through this shell. Default: `currentWindowsShell()`, or cmd.exe when `env` is given. */
	windowsShell?: ResolvedShell;
};

const DEFAULT_POSIX_SHELL: PosixShell = ["sh", "-c"];

export function shellInvocation(command: string, options: ShellOptions = {}): ShellInvocation {
	const { platform = process.platform, env = process.env, posix = DEFAULT_POSIX_SHELL } = options;
	if (platform === "win32") {
		// An explicit env is a hermetic call (tests): no settings read, no disk probe.
		const shell = options.windowsShell ?? (options.env ? undefined : currentWindowsShell());
		if (shell?.kind === "git-bash") {
			return { file: shell.file, args: ["-c", command], windowsVerbatimArguments: false };
		}
		if (shell?.kind === "powershell") {
			return {
				file: shell.file,
				args: ["-NoProfile", "-NonInteractive", "-Command", command],
				windowsVerbatimArguments: false,
			};
		}
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
	/** Windows only: force a shell (the `powershell` tool). Default: the resolved shell. */
	windowsShell?: ResolvedShell;
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
	const { posix, windowsShell, processGroup = false, ...spawnOptions } = options;
	const shell = shellInvocation(command, { posix, windowsShell });
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
