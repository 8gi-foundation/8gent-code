/**
 * @8gent/runtime — managed Node 22 runtime under ~/.8gent/runtime/.
 *
 * Public surface:
 *   - planInstall, installRuntime  (download + extract)
 *   - isRuntimeReady               (probe an existing install)
 *   - resolvedNodeBinPath          (where the binary lives)
 *   - getRuntimeDir                (where the install dir lives)
 *   - ensureNodeFor                (one-shot helper for spawn flows)
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { installRuntime } from "./installer.js";
import {
	getRuntimeDir,
	isRuntimeReady,
	parseNodeVersion,
	resolvedNodeBinPath,
	satisfiesMinVersion,
} from "./node-runtime.js";

const execFileAsync = promisify(execFile);

export {
	buildDownloadUrl,
	getRuntimeDir,
	isRuntimeReady,
	parseNodeVersion,
	pickPlatformAsset,
	resolvedNodeBinPath,
	satisfiesMinVersion,
} from "./node-runtime.js";
export type { NodeVersion, PlatformAsset, RuntimeLocator, RuntimeReadyOpts } from "./node-runtime.js";
export { installRuntime, planInstall } from "./installer.js";
export type { InstallInput, InstallPlan, InstallResult } from "./installer.js";

/** The Node version we manage. Bump when an upstream LTS we care about changes.
 * 22.14.0 is the floor required by openclaw and a known-good 22 LTS as of
 * Apr 2026. */
export const MANAGED_NODE_VERSION = "22.14.0";

/**
 * One-shot helper for spawn flows: ensures a Node binary that satisfies
 * `minVersion` is available, and returns its bin directory so the caller
 * can prepend it to PATH for a child process.
 *
 * Resolution order:
 *   1. If the user's `node` on $PATH already satisfies minVersion, no
 *      action needed; returns `null` (caller does nothing).
 *   2. If the managed runtime at ~/.8gent/runtime/node-<MANAGED>/ is
 *      ready and satisfies minVersion, returns its bin dir.
 *   3. Otherwise downloads + extracts the managed runtime, then
 *      returns its bin dir. Throws on install failure.
 *
 * Callers prepend the returned dir to PATH:
 *   const binDir = await ensureNodeFor("22.12.0");
 *   const env = binDir
 *     ? { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` }
 *     : { ...process.env };
 */
export async function ensureNodeFor(minVersion: string): Promise<string | null> {
	// Step 1: check user's Node.
	try {
		const { stdout } = await execFileAsync("node", ["--version"], {
			timeout: 3000,
		});
		const parsed = parseNodeVersion(stdout);
		if (parsed && satisfiesMinVersion(parsed, minVersion)) {
			return null; // user's Node is fine
		}
	} catch {
		/* user has no Node, fall through to managed runtime */
	}

	// Step 2: probe managed runtime.
	const ready = await isRuntimeReady({
		version: MANAGED_NODE_VERSION,
		minVersion,
	});
	const dir = getRuntimeDir({ version: MANAGED_NODE_VERSION });
	const binDir = process.platform === "win32" ? dir : join(dir, "bin");
	if (ready) return binDir;

	// Step 3: install.
	const result = await installRuntime({
		version: MANAGED_NODE_VERSION,
		minVersion,
	});
	if (result.action === "failed") {
		throw new Error(
			`failed to install Node ${MANAGED_NODE_VERSION}: ${result.error ?? "unknown"}`,
		);
	}
	return binDir;
}

/** The default managed runtime root, exposed for diagnostics. */
export function defaultRuntimeRoot(): string {
	return join(homedir(), ".8gent", "runtime");
}
