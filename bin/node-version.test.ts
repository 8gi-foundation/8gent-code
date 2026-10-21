import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nodeTooOld, tooOldMessage } from "./node-version.js";

describe("node version gate", () => {
	test("22.5 and newer pass, older fail", () => {
		for (const v of ["22.5.0", "22.13.1", "23.0.0", "24.1.0"]) expect(nodeTooOld(v)).toBe(false);
		for (const v of ["22.4.9", "21.5.0", "20.19.0", "18.0.0"]) expect(nodeTooOld(v)).toBe(true);
	});
	test("message is the one clear line", () => {
		expect(tooOldMessage("20.1.0")).toBe(
			"8gent needs Node 22.5 or newer (found 20.1.0). Install Node 22 or Bun.",
		);
	});
	const oldNode = "/usr/local/bin/node";
	test.skipIf(
		!existsSync(oldNode) ||
			spawnSync(oldNode, ["-p", "+process.versions.node.split('.')[0] < 22"])
				.stdout.toString()
				.trim() !== "true",
	)("launcher on a real old Node, no Bun, exits 1 with that line", () => {
		const r = spawnSync(oldNode, [join(import.meta.dir, "8gent-run.js"), "--version"], {
			env: {
				PATH: "/usr/bin:/bin",
				EIGHT_RUNTIME: "node",
				EIGHT_BOOT_TRACE: "0",
				HOME: process.env.TMPDIR ?? "/tmp",
			},
		});
		expect(r.status).toBe(1);
		expect(r.stderr.toString().trim()).toMatch(
			/^8gent needs Node 22\.5 or newer \(found \d+\.\d+\.\d+\)\. Install Node 22 or Bun\.$/,
		);
	});
});
