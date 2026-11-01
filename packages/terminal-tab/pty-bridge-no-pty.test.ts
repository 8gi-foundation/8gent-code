/**
 * #3256: node-pty is an optionalDependency. On a machine without build tools
 * npm skips it, and the bridge must then explain itself inside the terminal
 * tab and exit with its own code, not die on a stack trace nobody sees.
 *
 * The bridge is copied to a temp folder outside the repo, so
 * require("node-pty") cannot resolve, exactly as in an install that skipped it.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findNodeBinary } from "./find-node.js";

const nodeBin = findNodeBinary();

describe("pty-bridge without node-pty", () => {
	it.if(Boolean(nodeBin))("says terminal tabs are unavailable and exits 66", () => {
		const dir = mkdtempSync(join(tmpdir(), "8gent-no-pty-"));
		try {
			const bridge = join(dir, "pty-bridge.cjs");
			copyFileSync(join(import.meta.dir, "pty-bridge.cjs"), bridge);
			const r = spawnSync(nodeBin as string, [bridge, "/bin/sh"], {
				cwd: dir,
				encoding: "utf-8",
				// Minimal env on purpose: no NODE_PATH that could resolve node-pty.
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir } as unknown as NodeJS.ProcessEnv,
				timeout: 15_000,
			});
			expect(r.status).toBe(66);
			const msgs = r.stdout
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l));
			expect(msgs[0].type).toBe("data");
			expect(msgs[0].data).toContain("Terminal tabs are unavailable");
			expect(msgs[0].data).toContain("sudo apt install python3 make g++");
			expect(msgs[1]).toMatchObject({ type: "exit", code: 66, signal: null });
			expect(msgs[1].error).toContain("node-pty");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
