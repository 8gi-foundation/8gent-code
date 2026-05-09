/**
 * Peekaboo CLI subprocess wrapper.
 *
 * All Peekaboo invocations route through here so subprocess management,
 * JSON envelope parsing, and error semantics live in exactly one place.
 *
 * Peekaboo's --json envelope shape (verified against upstream docs):
 *   { "success": true,  "data": <payload>, "error": null }
 *   { "success": false, "data": null,      "error": { code, message } }
 *
 * We surface both error states as a typed { ok: false, reason } so the
 * backend never throws on a tool-level Peekaboo failure; only on
 * "binary not found" or "JSON unparseable" do we throw.
 */

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PeekabooEnvelope<T> {
	success: boolean;
	data: T | null;
	error: { code?: string; message: string } | null;
}

export type PeekabooResult<T> =
	| { ok: true; data: T; raw: PeekabooEnvelope<T> }
	| { ok: false; reason: string; raw?: PeekabooEnvelope<unknown> };

export interface RunOpts {
	binaryPath?: string;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 25_000;

function which(bin: string): string | null {
	const r = spawnSync("/usr/bin/which", [bin], { encoding: "utf-8" });
	if (r.status !== 0) return null;
	const out = r.stdout.trim();
	return out.length > 0 ? out : null;
}

let _resolvedBinary: string | null | undefined;

export function resolvePeekabooBinary(override?: string): string | null {
	if (override) return override;
	if (_resolvedBinary !== undefined) return _resolvedBinary;
	_resolvedBinary = which("peekaboo");
	return _resolvedBinary;
}

export function resetPeekabooBinaryCache(): void {
	_resolvedBinary = undefined;
}

export async function isPeekabooAvailable(opts: RunOpts = {}): Promise<boolean> {
	const bin = resolvePeekabooBinary(opts.binaryPath);
	if (!bin) return false;
	try {
		await execFileAsync(bin, ["--version"], { timeout: 5_000, env: opts.env });
		return true;
	} catch {
		return false;
	}
}

export async function runPeekaboo<T = unknown>(
	args: string[],
	opts: RunOpts = {},
): Promise<PeekabooResult<T>> {
	const bin = resolvePeekabooBinary(opts.binaryPath);
	if (!bin) {
		return {
			ok: false,
			reason:
				"peekaboo binary not found on PATH. Install: brew install steipete/tap/peekaboo",
		};
	}
	const argsWithJson = args.includes("--json") ? args : [...args, "--json"];
	let stdout: string;
	try {
		const result = await execFileAsync(bin, argsWithJson, {
			timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			env: opts.env,
			maxBuffer: 64 * 1024 * 1024,
		});
		stdout = result.stdout;
	} catch (e) {
		const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
		// Peekaboo emits a structured envelope on stdout even on non-zero exit.
		if (err.stdout && err.stdout.trim().startsWith("{")) {
			stdout = err.stdout;
		} else {
			return {
				ok: false,
				reason: `peekaboo subprocess failed: ${err.message}${err.stderr ? ` | stderr: ${err.stderr.trim()}` : ""}`,
			};
		}
	}

	let env: PeekabooEnvelope<T>;
	try {
		env = JSON.parse(stdout) as PeekabooEnvelope<T>;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(
			`peekaboo returned unparseable JSON for args ${JSON.stringify(args)}: ${msg}`,
		);
	}

	if (env.success && env.data !== null) {
		return { ok: true, data: env.data, raw: env };
	}
	return {
		ok: false,
		reason: env.error?.message ?? "peekaboo returned success=false with no error payload",
		raw: env,
	};
}
