/**
 * Run a command string through the platform's shell, and kill what it started.
 *
 * On Windows the shell is chosen by resolveWindowsShell: settings.shell.path,
 * else Git Bash, else PowerShell 7, else cmd.exe from ComSpec. Commands the
 * model and users write are short POSIX-flavoured lines (`git status | tail`,
 * `echo x > file`), which Git Bash runs as written. The cmd.exe fallback runs
 * pipes and redirection the same way but has no ls, grep or $VAR, and its `^`
 * and `%` parse differently from POSIX, so the permission rules follow the
 * resolved shell (activeShellKind). Windows PowerShell 5.1 rejects `&&`, so it
 * is not a fallback, and a `bash` on PATH is often the WSL launcher in System32,
 * which runs the command in a Linux VM against a different filesystem.
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
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { loadSettings } from "../settings/store";
import { resolveHome } from "./home";
import { spawnSafe } from "./win-path";

export type ShellKind = "git-bash" | "powershell" | "cmd";

/** A Windows shell chosen by `resolveWindowsShell`. */
export type ResolvedShell = { kind: ShellKind; file: string };

export type ResolveShellDeps = {
	env?: Record<string, string | undefined>;
	exists?: (p: string) => boolean;
	/** settings.shell.path: an explicit shell to use, taken first when it is valid and exists. */
	shellPath?: string;
	/** Directories a planted binary could come from. Default: process.cwd(). */
	workspace?: string;
};

const win = path.win32;

function kindOfPath(file: string): ShellKind {
	const base = win.basename(file).toLowerCase();
	if (/^(bash|sh)(\.exe)?$/.test(base)) return "git-bash";
	if (/^(pwsh|powershell)(\.exe)?$/.test(base)) return "powershell";
	return "cmd";
}

/** settings.shell.path must be an absolute local drive path: `C:\...`, never UNC or relative. */
export function isLocalDrivePath(p: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(p) && !p.startsWith("\\\\") && !p.startsWith("//");
}

/** Absolute PATH entries only, none inside the workspace, the cwd or a node_modules folder. */
function trustedPathDirs(env: Record<string, string | undefined>, workspace: string): string[] {
	const ws = workspace ? win.resolve(workspace).toLowerCase() : "";
	return (env.Path ?? env.PATH ?? "")
		.split(";")
		.map((d) => d.trim().replace(/^"|"$/g, ""))
		.filter((d) => {
			if (!d || !isLocalDrivePath(d)) return false;
			const low = win.normalize(d).toLowerCase();
			if (/(^|[\\/])node_modules([\\/]|$)/.test(low)) return false;
			if (ws && (low === ws || low.startsWith(ws + "\\"))) return false;
			return true;
		});
}

/** The Git for Windows root that holds this bash.exe, or undefined if it is not under one. */
function gitRootOf(bash: string): string {
	const up = /[\\/]usr[\\/]bin[\\/]bash\.exe$/i.test(bash) ? 3 : 2;
	let root = bash;
	for (let i = 0; i < up; i++) root = win.dirname(root);
	return root;
}

/**
 * Pick the Windows shell: settings.shell.path, then Git Bash, then PowerShell 7
 * (pwsh), then cmd.exe. Windows PowerShell 5.1 is not a fallback: it rejects
 * `&&`, which cmd.exe runs. A `bash` on PATH is skipped on purpose, it is
 * usually the WSL launcher in System32. Git Bash is found under Program Files,
 * LocalAppData, or next to the `git` on PATH, and is accepted only inside a real
 * Git root (usr\bin\msys-2.0.dll present). Program Files is checked before PATH,
 * and PATH entries must be absolute and outside the workspace and node_modules,
 * so a repo cannot plant a bash.exe or pwsh.exe that 8gent then runs.
 */
export function resolveWindowsShell(deps: ResolveShellDeps = {}): ResolvedShell {
	const env = deps.env ?? process.env;
	const exists = deps.exists ?? existsSync;
	const workspace = deps.workspace ?? process.cwd();
	const configured = deps.shellPath?.trim();
	if (configured && isLocalDrivePath(configured) && exists(configured)) {
		return { kind: kindOfPath(configured), file: configured };
	}

	const roots = [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"]].filter((r): r is string => !!r);
	const pathDirs = trustedPathDirs(env, workspace);
	const candidates = roots.flatMap((r) => [win.join(r, "Git", "bin", "bash.exe"), win.join(r, "Git", "usr", "bin", "bash.exe")]);
	if (env.LOCALAPPDATA) candidates.push(win.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
	for (const dir of pathDirs) {
		if (/[\\/]system32$/i.test(dir)) continue; // WSL launcher lives here
		if (exists(win.join(dir, "git.exe"))) {
			// Git\cmd\git.exe or Git\bin\git.exe sit one level under the Git root.
			candidates.push(win.join(dir, "..", "bin", "bash.exe"));
		}
	}
	for (const c of candidates) {
		if (exists(c) && exists(win.join(gitRootOf(win.normalize(c)), "usr", "bin", "msys-2.0.dll"))) {
			return { kind: "git-bash", file: win.normalize(c) };
		}
	}

	const pwsh = findPwsh(env, exists, pathDirs);
	if (pwsh) return { kind: "powershell", file: pwsh };
	return { kind: "cmd", file: env.ComSpec || env.COMSPEC || "cmd.exe" };
}

/** pwsh.exe: Program Files first, then trusted PATH entries. */
function findPwsh(env: Record<string, string | undefined>, exists: (p: string) => boolean, pathDirs: string[]): string | undefined {
	const roots = [env.ProgramFiles, env.ProgramW6432].filter((r): r is string => !!r);
	const candidates = [...roots.map((r) => win.join(r, "PowerShell", "7", "pwsh.exe")), ...pathDirs.map((d) => win.join(d, "pwsh.exe"))];
	return candidates.find((c) => exists(c));
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
		logChosenShell(cachedShell, shellPath);
	}
	return cachedShell;
}

const forcedShell = new AsyncLocalStorage<ResolvedShell>();

/**
 * Run `fn` with a forced shell, so every permission and sanitizer check inside
 * (they call activeShellKind) judges the line the way that shell will parse it.
 * The `powershell` tool wraps its whole call in this.
 */
export function withForcedShell<T>(shell: ResolvedShell, fn: () => T): T {
	return forcedShell.run(shell, fn);
}

/**
 * The shell kind a command line will actually be parsed by: the Windows shell
 * (or the forced one, for the powershell tool), else "posix". Permission and
 * sanitizer rules read this so they follow the RESOLVED shell, not the OS.
 */
export function activeShellKind(windowsShell?: ResolvedShell): ShellKind | "posix" {
	if (windowsShell) return windowsShell.kind;
	const forced = forcedShell.getStore();
	if (forced) return forced.kind;
	return process.platform === "win32" ? currentWindowsShell().kind : "posix";
}

/** One line per process in ~/.8gent/logs/shell.log: which shell run_command uses and why. Best effort. */
function logChosenShell(shell: ResolvedShell, configured?: string): void {
	try {
		const dir = path.join(resolveHome(), ".8gent", "logs");
		mkdirSync(dir, { recursive: true });
		const why = configured ? (shell.file === configured ? "settings.shell.path" : "settings.shell.path ignored") : "auto";
		appendFileSync(path.join(dir, "shell.log"), `${new Date().toISOString()} ${describeShell(shell)} ${shell.file} (${why})\n`);
	} catch {
		// Logging is not worth a failed command.
	}
}

/** Test hook: forget the cached shell. */
export function resetShellCache(): void {
	cachedShell = undefined;
}

/** PowerShell 7 or Windows PowerShell for the optional `powershell` tool. Same trust rules as the shell. */
export function resolvePowerShell(deps: ResolveShellDeps = {}): ResolvedShell | undefined {
	const env = deps.env ?? process.env;
	const exists = deps.exists ?? existsSync;
	const pwsh = findPwsh(env, exists, trustedPathDirs(env, deps.workspace ?? process.cwd()));
	if (pwsh) return { kind: "powershell", file: pwsh };
	const ps5 = env.SystemRoot ? win.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : undefined;
	return ps5 && exists(ps5) ? { kind: "powershell", file: ps5 } : undefined;
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

/** A copy of `env` without the variables that make a shell source a startup script. */
export function withoutShellStartupVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out = { ...env };
	for (const k of Object.keys(out)) if (k.toUpperCase() === "BASH_ENV" || k.toUpperCase() === "ENV") delete out[k];
	return out;
}

export function spawnShell(
	command: string,
	options?: SpawnShellOptions & { stdio?: StdioPipeNamed | StdioPipe[] },
): ChildProcessWithoutNullStreams;
export function spawnShell(command: string, options: SpawnShellOptions): ChildProcess;
export function spawnShell(command: string, options: SpawnShellOptions = {}): ChildProcess {
	const { posix, windowsShell, processGroup = false, ...spawnOptions } = options;
	const shell = shellInvocation(command, { posix, windowsShell });
	const kind = process.platform === "win32" ? (windowsShell ?? currentWindowsShell()).kind : undefined;
	return spawnSafe(shell.file, shell.args, {
		windowsHide: true,
		...spawnOptions,
		// BASH_ENV and ENV name a script bash sources before the command: a planted one runs with every call.
		...(kind === "git-bash" ? { env: withoutShellStartupVars(spawnOptions.env ?? process.env) } : {}),
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
