/**
 * Commands the model runs get a minimal environment. Driven through the real
 * ToolExecutor run_command path, plus unit checks on buildChildEnv.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKeysIntoEnv } from "../secrets/keys";
import { getBackgroundTaskManager } from "../tools/background";
import { GH_ENV_NAMES, GIT_ENV_NAMES, buildChildEnv, envPassList } from "./harness/child-env";
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

	test("git list keeps identity and the ssh socket, drops config and exec overrides", () => {
		const e = buildChildEnv(
			{
				...src,
				GIT_CONFIG_VALUE_0: "v",
				GIT_CONFIG_GLOBAL: "/g",
				GIT_EXEC_PATH: "/x",
				GIT_PROXY_COMMAND: "p",
			},
			GIT_ENV_NAMES,
		);
		expect(e.GIT_AUTHOR_NAME).toBe("x");
		expect(e.SSH_AUTH_SOCK).toBe("/s");
		for (const k of [
			"GIT_CONFIG_VALUE_0",
			"GIT_CONFIG_GLOBAL",
			"GIT_EXEC_PATH",
			"GIT_PROXY_COMMAND",
			"OPENROUTER_API_KEY",
		])
			expect(e[k]).toBeUndefined();
	});

	test("gh names pass only when asked for", () => {
		const s2 = { ...src, GH_TOKEN: "t", GITHUB_TOKEN: "u" };
		expect(buildChildEnv(s2).GH_TOKEN).toBeUndefined();
		expect(buildChildEnv(s2, GH_ENV_NAMES).GH_TOKEN).toBe("t");
	});

	test("pass list is comma or space separated", () => {
		expect(envPassList({ EIGHT_SHELL_ENV_PASS: "A, B  C,," })).toEqual(["A", "B", "C"]);
		expect(buildChildEnv({ ...src, EIGHT_SHELL_ENV_PASS: "EXTRA" }).EXTRA).toBe("e");
	});
});

describe("other model-reachable spawn paths", () => {
	test("background_start children do not see the canary", async () => {
		const mgr = getBackgroundTaskManager(dir);
		const id = mgr.startTask("env", { workingDirectory: dir });
		const info = await mgr.waitForTask(id, 10_000);
		expect(info?.status).toBe("completed");
		const out = JSON.stringify(mgr.getTaskOutput(id));
		expect(out).toContain("PATH=");
		expect(out).not.toContain(CANARY);
	});

	test("gh helper gets GH_TOKEN, run_command does not, canary never", async () => {
		const bin = join(dir, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "gh"),
			'#!/bin/sh\nprintf "tok=[%s] canary=[%s]" "$GH_TOKEN" "$FAKE_SECRET_KEY"\n',
		);
		chmodSync(join(bin, "gh"), 0o755);
		const oldPath = process.env.PATH;
		process.env.PATH = `${bin}:${oldPath}`;
		process.env.GH_TOKEN = "ghtok";
		try {
			const viaHelper = (await ex.execute("gh_pr_view", { number: "1" })) as string;
			expect(viaHelper).toContain("tok=[ghtok] canary=[]");
			const viaShell = await run("gh");
			expect(viaShell).toContain("tok=[]");
			expect(viaShell).toContain("canary=[]");
		} finally {
			process.env.PATH = oldPath;
		}
	});

	test("git helper drops GIT_CONFIG_* but keeps identity", async () => {
		const sh = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: dir });
		sh("init", "-q");
		sh("-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i");
		const hook = join(dir, ".git", "hooks", "post-checkout");
		const dump = join(dir, "hook-env.txt");
		writeFileSync(hook, `#!/bin/sh\nenv > "${dump}"\n`);
		chmodSync(hook, 0o755);
		process.env.GIT_CONFIG_VALUE_0 = CANARY;
		process.env.GIT_AUTHOR_NAME = "keepme";
		await ex.execute("git_create_branch", { branch: "probe" });
		expect(existsSync(dump)).toBe(true);
		const env = readFileSync(dump, "utf-8");
		expect(env).not.toContain(CANARY);
		expect(env).not.toContain("GIT_CONFIG_VALUE_0");
		expect(env).toContain("GIT_AUTHOR_NAME=keepme");
	});
});

describe("keys file cannot widen the pass list", () => {
	test("EIGHT_SHELL_ENV_ lines are ignored, other keys still load", () => {
		const f = join(dir, "keys.env");
		writeFileSync(f, "EIGHT_SHELL_ENV_PASS=FAKE_SECRET_KEY\nFAKE_LOADED_KEY=ok\n");
		delete process.env.FAKE_LOADED_KEY;
		try {
			expect(loadKeysIntoEnv(f)).toBe(1);
			expect(process.env.EIGHT_SHELL_ENV_PASS).toBeUndefined();
			expect(process.env.FAKE_LOADED_KEY).toBe("ok");
		} finally {
			delete process.env.FAKE_LOADED_KEY;
		}
	});
});
