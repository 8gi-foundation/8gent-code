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
 *   4. `node` on the user's PATH, resolved here to an absolute path using
 *      only entries outside `cwd` (pathOutsideFolder, #4783). A `node` the
 *      project planted on "." or in node_modules/.bin is never run; with no
 *      node outside the folder the result is null and the caller refuses.
 *
 * Steps 1 and 2 require an executable file (#4147): a managed node that
 * exists but lost its mode bit falls through instead of failing at execvp.
 */

import { constants, accessSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathOutsideFolder } from "../eight/welcome.js";
import { findOnPath } from "../voice/termux.js";

// Pinned to MANAGED_NODE_VERSION in packages/runtime/index.ts by find-node.test.ts.
export const MANAGED_NODE_VERSIONS = ["22.14.0"];

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function findNodeBinary(cwd: string = process.cwd()): string | null {
	const fromEnv = process.env.NODE_8GENT_BIN;
	if (fromEnv && isExecutable(fromEnv)) return fromEnv;

	for (const ver of MANAGED_NODE_VERSIONS) {
		const candidate = join(homedir(), ".8gent", "runtime", `node-${ver}`, "bin", "node");
		if (isExecutable(candidate)) return candidate;
	}

	const exec = process.execPath;
	if (exec && /\/node$/.test(exec)) return exec;

	return findOnPath("node", { PATH: pathOutsideFolder(String(process.env.PATH ?? ""), cwd) });
}
