/**
 * Commands the model runs get a minimal environment. Driven through the real
 * ToolExecutor run_command path, plus unit checks on buildChildEnv.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildEnv, envPassList } from "./harness/child-env";
import { ToolExecutor } from "./tools";

const CANARY = "canary-value-7f3a91";
const NAMES = [
	"FAKE_SECRET_KEY",
	"FAKE_DEPLOY_KEY",
	"EIGHT_SHELL_ENV_PASS",
	"EIGHT_SHELL_ENV_INHERIT",
];
let dir: string;
let ex: ToolExecutor;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const n of NAMES) saved[n] = process.env[n];
	for (const n of NAMES) delete process.env[n];
	process.env.FAKE_SECRET_KEY = CANARY;
	process.env.FAKE_DEPLOY_KEY = `${CANARY}-deploy`;
	dir = mkdtempSync(join(tmpdir(), "child-env-"));
	ex = new ToolExecutor(dir);
});

afterEach(() => {
	for (const n of NAMES) {
		if (saved[n] === undefined) delete process.env[n];
		else process.env[n] = saved[n];
	}
	rmSync(dir, { recursive: true, force: true });
});

const run = (command: string) => ex.execute("run_command", { command }) as Promise<string>;

describe("run_command environment", () => {
	test("a parent variable outside the allowlist is not visible to the child", async () => {
		const out = await run('printf "[%s][%s]" "$FAKE_SECRET_KEY" "$FAKE_DEPLOY_KEY"');
		expect(out).toContain("[][]");
		expect(await run("env")).not.toContain(CANARY);
	});

	test("ordinary settings still reach the child", async () => {
		const out = await run('printf "path=%s home=%s" "${PATH:+yes}" "${HOME:+yes}"');
		expect(out).toContain("path=yes home=yes");
	});

	test("a variable named in EIGHT_SHELL_ENV_PASS passes, and only that one", async () => {
		process.env.EIGHT_SHELL_ENV_PASS = "FAKE_DEPLOY_KEY";
		const out = await run('printf "[%s][%s]" "$FAKE_SECRET_KEY" "$FAKE_DEPLOY_KEY"');
		expect(out).toContain(`[][${CANARY}-deploy]`);
	});

	test("EIGHT_SHELL_ENV_INHERIT=1 restores full inheritance", async () => {
		process.env.EIGHT_SHELL_ENV_INHERIT = "1";
		const out = await run('printf "[%s]" "$FAKE_SECRET_KEY"');
		expect(out).toContain(`[${CANARY}]`);
	});
});

describe("buildChildEnv", () => {
	const src = {
		PATH: "/bin",
		HOME: "/h",
		LC_ALL: "C",
		LC_CTYPE: "C",
		TERM: "xterm",
		GIT_AUTHOR_NAME: "x",
		SSH_AUTH_SOCK: "/s",
		OPENROUTER_API_KEY: "k",
		EXTRA: "e",
	};

	test("keeps the base set and LC_*, drops everything else", () => {
		expect(buildChildEnv(src)).toEqual({
			PATH: "/bin",
			HOME: "/h",
			LC_ALL: "C",
			LC_CTYPE: "C",
			TERM: "xterm",
		});
	});

	test("call-site names and prefixes widen only that call", () => {
		const e = buildChildEnv(src, ["SSH_AUTH_SOCK"], ["GIT_"]);
		expect(e.GIT_AUTHOR_NAME).toBe("x");
		expect(e.SSH_AUTH_SOCK).toBe("/s");
		expect(e.OPENROUTER_API_KEY).toBeUndefined();
	});

	test("pass list is comma or space separated", () => {
		expect(envPassList({ EIGHT_SHELL_ENV_PASS: "A, B  C,," })).toEqual(["A", "B", "C"]);
		expect(buildChildEnv({ ...src, EIGHT_SHELL_ENV_PASS: "EXTRA" }).EXTRA).toBe("e");
	});
});
