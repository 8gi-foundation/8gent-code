/**
 * Hooks run in the calling agent's directory, not the last-built agent's (#3147).
 *
 * The hook manager is one per process (it holds the registered hooks). Before
 * this fix every Agent, every ToolExecutor and every native run_command wrote
 * its directory into that shared manager, and shell, script and YAML hooks ran
 * in whatever directory was written last. So a second agent in the process
 * moved the first agent's hooks. Now each call carries its own directory.
 *
 * Runs in a subprocess with a throwaway HOME, since registering a hook
 * persists it to ~/.8gent/hooks.json.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hookdirs-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const shellLog = path.join(root, "shell.log");
const yamlLog = path.join(root, "yaml.log");
const dirA = path.join(root, "agent-a");
const dirB = path.join(root, "agent-b");

beforeAll(() => {
	const home = path.join(root, "home");
	for (const d of [home, dirA, dirB]) fs.mkdirSync(d, { recursive: true });
	const yaml = path.join(root, "hooks.yaml");
	fs.writeFileSync(yaml, `- event: PreToolUse\n  matcher: "*"\n  command: pwd >> '${yamlLog}'\n`);

	const probe = Bun.spawnSync(
		[
			process.execPath,
			path.join(import.meta.dir, "__tests__", "fixtures", "hook-dirs-probe.ts"),
			dirA,
			dirB,
			shellLog,
		],
		{
			env: { ...process.env, HOME: home, EIGHT_HOOKS_YAML: yaml },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const detail = `${probe.stdout.toString()}\n${probe.stderr.toString()}`;
	if (probe.exitCode !== 0) throw new Error(`probe exited ${probe.exitCode}\n${detail}`);
});

test("text-tool path: A's beforeCommand hook runs in A, not in B built after it", () => {
	expect(fs.readFileSync(shellLog, "utf8").trim().split("\n")).toEqual([dirA, dirB]);
});

test("native path: the PreToolUse hook A fires runs in A, not in the last-built B", () => {
	expect(fs.readFileSync(yamlLog, "utf8").trim()).toBe(dirA);
});
