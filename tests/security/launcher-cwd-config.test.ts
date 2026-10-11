/**
 * The npm launcher (bin/8gent-run.js) must not let the user's working
 * directory steer Bun (#4013, 8SO): a workspace bunfig.toml `preload` would run
 * code before 8gent snapshots its security env, and a workspace .env would set
 * EIGHT_SEATBELT=0 for it. The launcher passes --no-env-file and its own empty
 * bunfig. This runs the real launcher against a stub dist/cli.js.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dirname, "../..");

describe("bin/8gent-run.js", () => {
	test("a cwd bunfig preload and a cwd .env are not loaded", () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "launcher-cwd-")));
		try {
			const pkg = path.join(root, "pkg");
			fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
			fs.mkdirSync(path.join(pkg, "dist"));
			fs.copyFileSync(path.join(REPO, "bin", "8gent-run.js"), path.join(pkg, "bin", "8gent-run.js"));
			fs.copyFileSync(path.join(REPO, "bin", "bunfig.empty.toml"), path.join(pkg, "bin", "bunfig.empty.toml"));
			fs.writeFileSync(path.join(pkg, "package.json"), '{"type":"module"}\n');
			fs.writeFileSync(
				path.join(pkg, "dist", "cli.js"),
				'console.log(`CLI seatbelt=${process.env.EIGHT_SEATBELT ?? "unset"} preload=${globalThis.__evilPreload ? "ran" : "no"}`);\n',
			);

			const ws = path.join(root, "workspace");
			fs.mkdirSync(ws);
			fs.writeFileSync(path.join(ws, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
			fs.writeFileSync(path.join(ws, "evil.ts"), "globalThis.__evilPreload = true;\nconsole.log('EVIL PRELOAD');\n");
			fs.writeFileSync(path.join(ws, ".env"), "EIGHT_SEATBELT=0\n");

			const env = { ...process.env };
			delete env.EIGHT_SEATBELT;
			const r = spawnSync("node", [path.join(pkg, "bin", "8gent-run.js")], { cwd: ws, env, encoding: "utf8" });
			expect(r.stdout).toContain("CLI seatbelt=unset preload=no");
			expect(r.stdout).not.toContain("EVIL PRELOAD");

			// Control: plain `bun` from that cwd does load both, so the test can fail.
			const control = spawnSync("bun", [path.join(pkg, "dist", "cli.js")], { cwd: ws, env, encoding: "utf8" });
			expect(control.stdout).toContain("EVIL PRELOAD");
			expect(control.stdout).toContain("seatbelt=0");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
