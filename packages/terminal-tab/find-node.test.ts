/**
 * #4147: findNodeBinary must return only an executable node. A managed
 * runtime that exists but lost its mode bit (partial unpack) falls through
 * to the next step instead of failing later at execvp.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANAGED_NODE_VERSION } from "../runtime/index.js";
import { MANAGED_NODE_VERSIONS } from "./find-node.js";

const posix = process.platform !== "win32";

let home: string;

// os.homedir() is read once per process, so resolve in a child with HOME
// pointed at the temp dir, the way pty-bridge-no-pty.test.ts overrides HOME.
function resolveWith(env: Record<string, string>, cwd?: string): string {
	const mod = JSON.stringify(join(import.meta.dir, "find-node.ts"));
	const r = spawnSync(
		process.execPath,
		["-e", `import { findNodeBinary } from ${mod}; console.log(findNodeBinary());`],
		{
			encoding: "utf-8",
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				HOME: home,
				...env,
			} as unknown as NodeJS.ProcessEnv,
			timeout: 15_000,
			...(cwd ? { cwd } : {}),
		},
	);
	if (r.status !== 0) throw new Error(`resolver child failed: ${r.stderr}`);
	return r.stdout.trim();
}

function managedNode(mode: number): string {
	const dir = join(home, ".8gent", "runtime", `node-${MANAGED_NODE_VERSIONS[0]}`, "bin");
	mkdirSync(dir, { recursive: true });
	const bin = join(dir, "node");
	writeFileSync(bin, "#!/bin/sh\n");
	chmodSync(bin, mode);
	return bin;
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "8gent-find-node-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("findNodeBinary executable check", () => {
	it.if(posix)("skips a managed node that is not executable (mode 0644)", () => {
		const bin = managedNode(0o644);
		const got = resolveWith({});
		expect(got).not.toBe(bin);
		expect(got).not.toContain(home);
	});

	it.if(posix)("returns a managed node that is executable", () => {
		const bin = managedNode(0o755);
		expect(resolveWith({})).toBe(bin);
	});

	it.if(posix)("skips a NODE_8GENT_BIN that is not executable", () => {
		const bin = managedNode(0o755);
		const bad = join(home, "not-exec-node");
		writeFileSync(bad, "");
		chmodSync(bad, 0o644);
		expect(resolveWith({ NODE_8GENT_BIN: bad })).toBe(bin);
	});
});

describe("PATH fallback stays outside the folder (#4783)", () => {
	it.if(posix)("a node planted in the project is never chosen; none outside gives null", () => {
		// The child's process.cwd() is the realpath (/tmp is /private/tmp on macOS).
		const project = join(realpathSync(home), "proj");
		const bin = join(project, "node_modules", ".bin");
		mkdirSync(bin, { recursive: true });
		for (const d of [project, bin]) {
			writeFileSync(join(d, "node"), "#!/bin/sh\ntouch PWNED\n");
			chmodSync(join(d, "node"), 0o755);
		}
		const got = resolveWith({ PATH: `.:node_modules/.bin:${bin}` }, project);
		expect(got).toBe("null");
	});

	it.if(posix)("a node outside the folder resolves to its absolute path", () => {
		const project = join(realpathSync(home), "proj");
		const outside = join(realpathSync(home), "tools");
		mkdirSync(project, { recursive: true });
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "node"), "#!/bin/sh\n");
		chmodSync(join(outside, "node"), 0o755);
		writeFileSync(join(project, "node"), "#!/bin/sh\n");
		chmodSync(join(project, "node"), 0o755);
		expect(resolveWith({ PATH: `.:${outside}` }, project)).toBe(join(outside, "node"));
	});
});

describe("managed Node version", () => {
	it("matches the version @8gent/runtime installs", () => {
		expect(MANAGED_NODE_VERSIONS).toContain(MANAGED_NODE_VERSION);
	});
});
