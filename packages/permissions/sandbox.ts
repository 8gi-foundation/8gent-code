/**
 * 8gent Code - Sandbox Executor
 *
 * Layered sandboxing inspired by Unikraft micro-VMs
 * (https://github.com/unikraft/unikraft) — sub-50ms boot pattern
 * abstracted into four isolation layers. Auto-detects best available.
 *
 * Layers (weakest -> strongest):
 *   process  — Bun.spawn, stripped env, timeout kill
 *   tempdir  — process + isolated temp dir, destroyed after run
 *   seatbelt — macOS sandbox-exec, kernel-enforced deny-by-default profile
 *              built from the tool's capability manifest (#2756 step 2)
 *   bwrap    - Linux bubblewrap + seccomp, the same deny-by-default intent in
 *              namespaces; no root, no KVM (8gi-governance#1108 lane 3)
 *   docker   — docker run --rm --network none, memory + CPU limits
 *   microvm  - not implemented; requesting it returns an unavailable result
 *
 * A requested layer that this host cannot enforce returns an unavailable
 * result (exit 126, command not run). It never falls back to a weaker layer.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { killProcessTree, shellInvocation } from "../core/shell";
import { buildBwrapArgv, bwrapStatus, seccompBytesForHost } from "./bwrap.js";
import type { IsolationLevel, SandboxOptions, SandboxResult } from "./sandbox-types.js";
import {
	buildSeatbeltProfile,
	isSeatbeltAvailable,
	seatbeltBinary,
	sessionScratchDir,
} from "./seatbelt.js";

// Re-export types for convenience
export type {
	IsolationLevel,
	SandboxOptions,
	SandboxResult,
} from "./sandbox-types.js";

// ============================================
// Detection
// ============================================

/** Minimal safe env — strip everything, keep only shell essentials */
function safeEnv(extra: Record<string, string> = {}): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		HOME: process.env.HOME ?? os.homedir(),
		TMPDIR: os.tmpdir(),
		...extra,
	};
}

/** Check if a binary is available on PATH */
async function hasBinary(bin: string): Promise<boolean> {
	try {
		const proc = Bun.spawn(["which", bin], {
			stdout: "pipe",
			stderr: "pipe",
			env: safeEnv(),
		});
		await proc.exited;
		return proc.exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * Detect the best available isolation level on this machine.
 * On macOS the seatbelt layer wins: it is kernel-enforced, path-scoped,
 * and needs no daemon. On Linux bwrap wins for the same reasons. Elsewhere
 * prefers docker, then tempdir.
 */
export async function detectBestIsolation(): Promise<IsolationLevel> {
	if (isSeatbeltAvailable()) return "seatbelt";
	if (bwrapStatus().available) return "bwrap";
	if (await hasBinary("docker")) {
		// Verify docker daemon is actually running (not just installed)
		try {
			const proc = Bun.spawn(["docker", "info"], {
				stdout: "pipe",
				stderr: "pipe",
				env: safeEnv(),
			});
			await proc.exited;
			if (proc.exitCode === 0) return "docker";
		} catch {
			// docker installed but daemon not running — fall through
		}
	}
	// tempdir is always available — it's just process + tmp cleanup
	return "tempdir";
}

// ============================================
// Execution layers
// ============================================

/** Layer 1+2: process + temp dir isolation */
async function runInTempdir(
	command: string,
	opts: Required<Pick<SandboxOptions, "timeout" | "allowNetwork" | "env">>,
	workDir?: string,
): Promise<SandboxResult> {
	const useTmp = !workDir;
	const tmpDir = useTmp ? fs.mkdtempSync(path.join(os.tmpdir(), "8gent-sandbox-")) : workDir!;

	const start = Date.now();
	let timedOut = false;
	let stdout = "";
	let stderr = "";
	let exitCode = 1;

	try {
		const sh = shellInvocation(command);
		const proc = Bun.spawn([sh.file, ...sh.args], {
			cwd: tmpDir,
			stdout: "pipe",
			stderr: "pipe",
			env: safeEnv(opts.env),
			windowsHide: true,
			windowsVerbatimArguments: sh.windowsVerbatimArguments,
		});

		const timer = setTimeout(() => {
			timedOut = true;
			killProcessTree(proc.pid, "SIGTERM");
		}, opts.timeout);

		const [out, err] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		clearTimeout(timer);

		stdout = out;
		stderr = err;
		exitCode = timedOut ? 124 : (proc.exitCode ?? 1);
	} finally {
		if (useTmp) {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
	}

	return {
		stdout,
		stderr,
		exitCode,
		timedOut,
		isolation: workDir ? "process" : "tempdir",
		durationMs: Date.now() - start,
	};
}

/** Layer 3 (macOS): kernel-enforced seatbelt via sandbox-exec */
async function runInSeatbelt(
	command: string,
	opts: Required<Pick<SandboxOptions, "timeout" | "allowNetwork" | "env">> &
		Pick<SandboxOptions, "readPaths" | "writePaths">,
	workDir?: string,
): Promise<SandboxResult> {
	const useTmp = !workDir;
	const runDir = useTmp ? fs.mkdtempSync(path.join(os.tmpdir(), "8gent-seatbelt-")) : workDir!;
	// mkdtemp can hand back a symlinked path (/var -> /private/var); the
	// kernel matches the real path, so the profile must use it too.
	const realRunDir = fs.realpathSync(runDir);

	const profile = buildSeatbeltProfile({
		workDir: realRunDir,
		readPaths: opts.readPaths,
		writePaths: opts.writePaths,
		allowNetwork: opts.allowNetwork,
	});

	const start = Date.now();
	let timedOut = false;
	let stdout = "";
	let stderr = "";
	let exitCode = 1;

	try {
		const proc = Bun.spawn([seatbeltBinary(), "-p", profile, "sh", "-c", command], {
			cwd: realRunDir,
			stdout: "pipe",
			stderr: "pipe",
			// HOME and TMPDIR point INSIDE the sandbox so tools that expand
			// them stay within the kernel-allowed surface.
			env: safeEnv({ ...opts.env, HOME: realRunDir, TMPDIR: realRunDir }),
		});

		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, opts.timeout);

		const [out, err] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		clearTimeout(timer);

		stdout = out;
		stderr = err;
		exitCode = timedOut ? 124 : (proc.exitCode ?? 1);
	} finally {
		if (useTmp) {
			try {
				fs.rmSync(runDir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
	}

	return {
		stdout,
		stderr,
		exitCode,
		timedOut,
		isolation: "seatbelt",
		durationMs: Date.now() - start,
	};
}

/** The command was not run: the requested isolation cannot be enforced here. */
function unavailableResult(isolation: IsolationLevel, reason: string): SandboxResult {
	return {
		stdout: "",
		stderr: `8gent sandbox: ${isolation} isolation unavailable: ${reason}. Command not run.\n`,
		exitCode: 126,
		timedOut: false,
		isolation,
		durationMs: 0,
		unavailable: reason,
	};
}

/** Layer 3 (Linux): bubblewrap namespaces + seccomp filter */
async function runInBwrap(
	command: string,
	opts: Required<Pick<SandboxOptions, "timeout" | "allowNetwork" | "env">> &
		Pick<SandboxOptions, "readPaths" | "writePaths">,
	workDir?: string,
): Promise<SandboxResult> {
	const status = bwrapStatus();
	if (!status.available) return unavailableResult("bwrap", status.reason);
	const seccomp = seccompBytesForHost();
	if (!seccomp) return unavailableResult("bwrap", `no seccomp table for ${process.arch}`);

	const useTmp = !workDir;
	const runDir = fs.realpathSync(
		useTmp ? fs.mkdtempSync(path.join(os.tmpdir(), "8gent-bwrap-")) : workDir!,
	);
	// The filter goes to bwrap on fd 3 from an unlinked file: nothing is left on disk.
	const filterPath = path.join(os.tmpdir(), `8gent-seccomp-${process.pid}-${Date.now()}.bpf`);
	fs.writeFileSync(filterPath, seccomp, { mode: 0o600 });
	const filterFd = fs.openSync(filterPath, "r");
	fs.rmSync(filterPath, { force: true });

	const argv = buildBwrapArgv(
		status.binary,
		{
			workDir: runDir,
			readPaths: opts.readPaths,
			writePaths: opts.writePaths,
			allowNetwork: opts.allowNetwork,
			env: safeEnv({ ...opts.env, HOME: runDir, TMPDIR: runDir }),
			seccompFd: 3,
		},
		command,
	);

	const start = Date.now();
	let timedOut = false;
	let stdout = "";
	let stderr = "";
	let exitCode = 1;

	try {
		const proc = Bun.spawn(argv, {
			cwd: runDir,
			// biome-ignore lint/suspicious/noExplicitAny: Bun accepts extra fds after stdio[2]
			stdio: ["ignore", "pipe", "pipe", filterFd] as any,
			env: { PATH: "/usr/bin:/bin" },
		});

		const timer = setTimeout(() => {
			timedOut = true;
			// --die-with-parent takes the sandboxed tree down with bwrap.
			proc.kill("SIGKILL");
		}, opts.timeout);

		const [out, err] = await Promise.all([
			new Response(proc.stdout as unknown as ReadableStream).text(),
			new Response(proc.stderr as unknown as ReadableStream).text(),
		]);
		await proc.exited;
		clearTimeout(timer);

		stdout = out;
		stderr = err;
		exitCode = timedOut ? 124 : (proc.exitCode ?? 1);
	} finally {
		fs.closeSync(filterFd);
		if (useTmp) {
			try {
				fs.rmSync(runDir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
	}

	return {
		stdout,
		stderr,
		exitCode,
		timedOut,
		isolation: "bwrap",
		durationMs: Date.now() - start,
	};
}

/** Layer 4: Docker container isolation */
async function runInDocker(
	command: string,
	opts: Required<Pick<SandboxOptions, "timeout" | "allowNetwork" | "env">>,
	workDir?: string,
): Promise<SandboxResult> {
	const useTmp = !workDir;
	const tmpDir = useTmp ? fs.mkdtempSync(path.join(os.tmpdir(), "8gent-docker-")) : workDir!;

	const start = Date.now();
	let timedOut = false;

	const networkFlag = opts.allowNetwork ? [] : ["--network", "none"];
	const envFlags = Object.entries(opts.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

	const dockerArgs = [
		"docker",
		"run",
		"--rm",
		...networkFlag,
		"--memory",
		"512m",
		"--cpus",
		"1",
		"--read-only",
		"--tmpfs",
		"/tmp",
		"-v",
		`${tmpDir}:/work`,
		"-w",
		"/work",
		...envFlags,
		"oven/bun:latest",
		"sh",
		"-c",
		command,
	];

	let stdout = "";
	let stderr = "";
	let exitCode = 1;

	try {
		const proc = Bun.spawn(dockerArgs, {
			stdout: "pipe",
			stderr: "pipe",
			env: safeEnv(),
		});

		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill();
		}, opts.timeout);

		const [out, err] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		clearTimeout(timer);

		stdout = out;
		stderr = err;
		exitCode = timedOut ? 124 : (proc.exitCode ?? 1);
	} finally {
		if (useTmp) {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
	}

	return {
		stdout,
		stderr,
		exitCode,
		timedOut,
		isolation: "docker",
		durationMs: Date.now() - start,
	};
}

// ============================================
// Public API
// ============================================

/**
 * Run a shell command in the best available sandbox.
 *
 * @example
 * const result = await runSandboxed("node -e 'console.log(1+1)'");
 * console.log(result.stdout); // "2\n"
 */
export async function runSandboxed(
	command: string,
	opts: SandboxOptions = {},
): Promise<SandboxResult> {
	const timeout = opts.timeout ?? 30_000;
	const allowNetwork = opts.allowNetwork ?? false;
	const env = opts.env ?? {};
	const isolation = opts.isolation ?? (await detectBestIsolation());

	const resolved = { timeout, allowNetwork, env };

	// Per-session scratch dir: shared across the session's runs, destroyed
	// with the session (destroySessionScratch), not after each command.
	const workDir = opts.workDir ?? (opts.sessionId ? sessionScratchDir(opts.sessionId) : undefined);

	if (opts.requireOsIsolation && isolation !== "seatbelt" && isolation !== "bwrap") {
		return unavailableResult(
			isolation,
			"no kernel-enforced sandbox on this host (needs macOS seatbelt or Linux bubblewrap)",
		);
	}

	const scopes = { readPaths: opts.readPaths, writePaths: opts.writePaths };

	if (isolation === "seatbelt") {
		if (!isSeatbeltAvailable()) {
			return unavailableResult(
				"seatbelt",
				`sandbox-exec is macOS only (this is ${process.platform})`,
			);
		}
		return runInSeatbelt(command, { ...resolved, ...scopes }, workDir);
	}

	if (isolation === "bwrap") {
		return runInBwrap(command, { ...resolved, ...scopes }, workDir);
	}

	if (isolation === "microvm") {
		return unavailableResult("microvm", "microVM isolation is not implemented");
	}

	if (isolation === "docker") {
		return runInDocker(command, resolved, workDir);
	}

	// process = explicit process-only (no temp dir creation/cleanup)
	if (isolation === "process") {
		return runInTempdir(command, resolved, workDir ?? process.cwd());
	}

	// tempdir
	return runInTempdir(command, resolved, workDir);
}
