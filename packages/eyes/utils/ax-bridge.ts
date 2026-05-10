/**
 * 8gent AX bridge subprocess wrapper.
 *
 * Replaces the v0 packages/eyes/utils/peekaboo-cli.ts wrapper. Spawns the
 * bundled Swift bridge at ~/.8gent/bin/8gent-ax-bridge with a single command
 * per call, parses the same `{ success, data, error }` envelope shape the
 * old peekaboo wrapper used so the rest of the eyes package keeps the same
 * result type.
 *
 * Resolve order for the binary:
 *   1. opts.binaryPath
 *   2. process.env.EIGHT_AX_BRIDGE_BIN
 *   3. ~/.8gent/bin/8gent-ax-bridge (default install location)
 *   4. <repo>/packages/eyes/native/swift/.build/release/EightAxBridge (dev)
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface BridgeEnvelope<T> {
	success: boolean;
	data: T | null;
	error: { code?: string; message: string } | null;
}

export type BridgeResult<T> =
	| { ok: true; data: T; raw: BridgeEnvelope<T> }
	| { ok: false; reason: string; raw?: BridgeEnvelope<unknown> };

export interface BridgeRunOpts {
	binaryPath?: string;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 25_000;

const HOME = homedir();
const DEFAULT_INSTALL = join(HOME, ".8gent", "bin", "8gent-ax-bridge");
// __dirname is not available with bun's ESM stack; resolve relative to this file via import.meta.url.
function devBuildPath(): string {
	const here = new URL(".", import.meta.url).pathname;
	return join(here, "..", "native", "swift", ".build", "release", "EightAxBridge");
}

let _resolvedBinary: string | null | undefined;

export function resolveBridgeBinary(override?: string): string | null {
	if (override) return override;
	if (_resolvedBinary !== undefined) return _resolvedBinary;
	const fromEnv = process.env.EIGHT_AX_BRIDGE_BIN;
	if (fromEnv && existsSync(fromEnv)) {
		_resolvedBinary = fromEnv;
		return _resolvedBinary;
	}
	if (existsSync(DEFAULT_INSTALL)) {
		_resolvedBinary = DEFAULT_INSTALL;
		return _resolvedBinary;
	}
	const dev = devBuildPath();
	if (existsSync(dev)) {
		_resolvedBinary = dev;
		return _resolvedBinary;
	}
	_resolvedBinary = null;
	return null;
}

export function resetBridgeBinaryCache(): void {
	_resolvedBinary = undefined;
}

export async function isBridgeAvailable(opts: BridgeRunOpts = {}): Promise<boolean> {
	const bin = resolveBridgeBinary(opts.binaryPath);
	if (!bin) return false;
	try {
		await execFileAsync(bin, ["--version"], { timeout: 5_000, env: opts.env });
		return true;
	} catch {
		return false;
	}
}

/**
 * Run the bridge with one command + JSON args. The bridge writes exactly one
 * envelope to stdout and exits, so we don't need a long-lived subprocess.
 */
export async function runBridge<T = unknown>(
	command: string,
	args: Record<string, unknown> = {},
	opts: BridgeRunOpts = {},
): Promise<BridgeResult<T>> {
	const bin = resolveBridgeBinary(opts.binaryPath);
	if (!bin) {
		return {
			ok: false,
			reason:
				"8gent-ax-bridge binary not found. Build it with: bash packages/eyes/native/build.sh (installs to ~/.8gent/bin/8gent-ax-bridge).",
		};
	}

	const cliArgs = [command, "--json-args", JSON.stringify(args)];
	let stdout: string;
	try {
		const result = await execFileAsync(bin, cliArgs, {
			timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			env: opts.env,
			maxBuffer: 64 * 1024 * 1024,
		});
		stdout = result.stdout;
	} catch (e) {
		const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
		// The bridge emits an envelope on stdout even when the command fails,
		// so we only fall through to "subprocess failed" when stdout is unusable.
		if (err.stdout && err.stdout.trim().startsWith("{")) {
			stdout = err.stdout;
		} else {
			return {
				ok: false,
				reason: `8gent-ax-bridge subprocess failed: ${err.message}${err.stderr ? ` | stderr: ${err.stderr.trim()}` : ""}`,
			};
		}
	}

	const trimmed = stdout.trim();
	if (!trimmed) {
		return {
			ok: false,
			reason: "8gent-ax-bridge produced no stdout",
		};
	}

	let env: BridgeEnvelope<T>;
	try {
		// Bridge writes one JSON object per line; take the last non-empty line
		// in case future versions emit progress lines.
		const lastLine = trimmed.split("\n").filter((l) => l.length > 0).pop() ?? trimmed;
		env = JSON.parse(lastLine) as BridgeEnvelope<T>;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(
			`8gent-ax-bridge returned unparseable JSON for command ${JSON.stringify(command)}: ${msg}`,
		);
	}

	if (env.success && env.data !== null) {
		return { ok: true, data: env.data, raw: env };
	}
	return {
		ok: false,
		reason: env.error?.message ?? "bridge returned success=false with no error payload",
		raw: env,
	};
}
