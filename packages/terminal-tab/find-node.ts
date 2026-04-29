/**
 * @8gent/terminal-tab — find-node.ts
 *
 * Locate a Node binary capable of running pty-bridge.cjs. node-pty's
 * native FD watcher needs a real Node runtime — Bun cannot drive it.
 *
 * Resolution order:
 *   1. NODE_8GENT_BIN env override (escape hatch for tests / odd setups)
 *   2. Managed runtime under ~/.8gent/runtime/node-X.Y.Z/bin/node
 *   3. process.execPath if it points at node (e.g. when pty-session
 *      itself runs under Node — happens during unit tests)
 *   4. `node` on the user's PATH (resolved by spawning execvp)
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MANAGED_NODE_VERSIONS = ["22.14.0"]; // keep aligned with @8gent/runtime

export function findNodeBinary(): string | null {
	const fromEnv = process.env.NODE_8GENT_BIN;
	if (fromEnv && existsSync(fromEnv)) return fromEnv;

	for (const ver of MANAGED_NODE_VERSIONS) {
		const candidate = join(homedir(), ".8gent", "runtime", `node-${ver}`, "bin", "node");
		if (existsSync(candidate)) return candidate;
	}

	const exec = process.execPath;
	if (exec && /\/node$/.test(exec)) return exec;

	return "node"; // PATH lookup at spawn time
}
