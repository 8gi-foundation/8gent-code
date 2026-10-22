import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeTooOld, tooOldMessage } from "./node-version.js";

describe("node version gate", () => {
	test("22.5 and newer pass, older fail", () => {
		for (const v of ["22.5.0", "22.13.1", "23.0.0", "24.1.0"]) expect(nodeTooOld(v)).toBe(false);
		for (const v of ["22.4.9", "21.5.0", "20.19.0", "18.0.0"]) expect(nodeTooOld(v)).toBe(true);
	});
	test("message is the one clear line", () => {
		const [first, ...rest] = tooOldMessage("20.1.0").split("\n");
		expect(first).toBe("8gent needs Node 22.5 or newer (found 20.1.0). Install Node 22 or Bun.");
		expect(rest.join("\n")).toContain("deb.nodesource.com/setup_22.x");
		expect(rest.join("\n")).toContain("pacman -Syu --noconfirm nodejs npm");
		expect(rest.join("\n")).toContain("nvm install 22");
	});
	test("a runtime killed by a signal exits 1 and names the signal and the escape", () => {
		const root = mkdtempSync(join(tmpdir(), "8gent-sig-"));
		try {
			mkdirSync(join(root, "bin"));
			mkdirSync(join(root, "dist"));
			mkdirSync(join(root, "fakebin"));
			for (const f of ["8gent-run.js", "node-version.js", "termux-exec.js", "bunfig.empty.toml"])
				copyFileSync(join(import.meta.dir, f), join(root, "bin", f));
			writeFileSync(join(root, "dist", "cli.js"), "");
			writeFileSync(join(root, "fakebin", "bun"), "#!/bin/sh\nkill -9 $$\n", { mode: 0o755 });
			const r = spawnSync(process.execPath, [join(root, "bin", "8gent-run.js")], {
				env: {
					PATH: `${join(root, "fakebin")}:/usr/bin:/bin`,
					EIGHT_BOOT_TRACE: "0",
					HOME: root,
				},
			});
			expect(r.status).toBe(1);
			expect(r.stderr.toString()).toContain("killed by SIGKILL");
			expect(r.stderr.toString()).toContain("EIGHT_RUNTIME=node");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
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
		expect(r.stderr.toString().split("\n")[0]).toMatch(
			/^8gent needs Node 22\.5 or newer \(found \d+\.\d+\.\d+\)\. Install Node 22 or Bun\.$/,
		);
	});
});
