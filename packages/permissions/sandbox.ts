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
 *   docker   — docker run --rm --network none, memory + CPU limits
 *   microvm  — reserved for future Unikraft/Firecracker integration
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type {
	IsolationLevel,
	SandboxOptions,
	SandboxResult,
} from "./sandbox-types.js";

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
 * Prefers docker when available, falls back to tempdir, then process.
 */
export async function detectBestIsolation(): Promise<IsolationLevel> {
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
	const tmpDir = useTmp
		? fs.mkdtempSync(path.join(os.tmpdir(), "8gent-sandbox-"))
		: workDir!;

	const start = Date.now();
	let timedOut = false;
	let stdout = "";
	let stderr = "";
	let exitCode = 1;

	try {
		const proc = Bun.spawn(["sh", "-c", command], {
			cwd: tmpDir,
			stdout: "pipe",
			stderr: "pipe",
			env: safeEnv(opts.env),
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
		isolation: workDir ? "process" : "tempdir",
		durationMs: Date.now() - start,
	};
}

/** Layer 3: Docker container isolation */
async function runInDocker(
	command: string,
	opts: Required<Pick<SandboxOptions, "timeout" | "allowNetwork" | "env">>,
	workDir?: string,
): Promise<SandboxResult> {
	const useTmp = !workDir;
	const tmpDir = useTmp
		? fs.mkdtempSync(path.join(os.tmpdir(), "8gent-docker-"))
		: workDir!;

	const start = Date.now();
	let timedOut = false;

	const networkFlag = opts.allowNetwork ? [] : ["--network", "none"];
	const envFlags = Object.entries(opts.env).flatMap(([k, v]) => [
		"-e",
		`${k}=${v}`,
	]);

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

	if (isolation === "docker") {
		return runInDocker(command, resolved, opts.workDir);
	}

	// process = explicit process-only (no temp dir creation/cleanup)
	if (isolation === "process") {
		return runInTempdir(command, resolved, opts.workDir ?? process.cwd());
	}

	// tempdir (default) or microvm fallback to tempdir until VMs are supported
	return runInTempdir(command, resolved, opts.workDir);
}
