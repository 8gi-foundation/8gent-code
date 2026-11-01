/**
 * A YAML hook that exits without reading stdin must not crash the process.
 *
 * runYamlHookCommand writes the payload to the hook's stdin. A hook such as
 * `echo '{"block": true}'` exits before reading it, so the write fails with
 * EPIPE. With no error listener on stdin that EPIPE was an uncaught exception:
 * on Linux it surfaced as a random test failure (tool-gate.test.ts), and in the
 * TUI it would take the session down. The hook's answer (here, a block) must
 * still count.
 *
 * Runs in a subprocess so an uncaught error fails this test, not a neighbour.
 */

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hookstdin-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// POSIX only: the hook is an sh command.
test.skipIf(process.platform === "win32")(
	"a hook that ignores stdin still blocks, and its EPIPE is not an uncaught error",
	() => {
		const home = path.join(root, "home");
		fs.mkdirSync(home, { recursive: true });
		const script = path.join(root, "block.sh");
		fs.writeFileSync(script, `echo '{"block": true, "reason": "frozen"}'\n`);
		const yaml = path.join(root, "hooks.yaml");
		fs.writeFileSync(yaml, `- event: PreToolUse\n  matcher: write_file\n  command: sh ${script}\n`);
		const probe = Bun.spawnSync(
			[
				process.execPath,
				path.join(import.meta.dir, "__tests__", "fixtures", "yaml-hook-stdin-probe.ts"),
			],
			{
				cwd: root,
				env: { ...process.env, HOME: home, EIGHT_HOOKS_YAML: yaml },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const stderr = probe.stderr.toString();
		expect(stderr).not.toContain("EPIPE");
		expect(probe.exitCode).toBe(0);
		expect(JSON.parse(probe.stdout.toString())).toEqual({ blocked: true, reason: "frozen" });
	},
);
