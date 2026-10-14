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
import {
	BASE_NAMES,
	ENV_PASS_HINT,
	GH_ENV_NAMES,
	GIT_ENV_NAMES,
	SECRETISH,
	buildChildEnv,
	envPassList,
	withheldAny,
} from "./harness/child-env";
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
			expect(Reflect.get(process.env, "FAKE_LOADED_KEY")).toBe("ok");
		} finally {
			delete process.env.FAKE_LOADED_KEY;
		}
	});
});

describe("default toolchain and proxy allowlist", () => {
	test("toolchain paths and XDG_* pass", () => {
		const e = buildChildEnv({
			VIRTUAL_ENV: "/v",
			JAVA_HOME: "/j",
			NODE_ENV: "test",
			XDG_CONFIG_HOME: "/x",
			KUBECONFIG: "/k",
			SSL_CERT_FILE: "/c",
			OTHER_THING: "o",
		});
		expect(Object.keys(e).sort()).toEqual([
			"JAVA_HOME",
			"KUBECONFIG",
			"NODE_ENV",
			"SSL_CERT_FILE",
			"VIRTUAL_ENV",
			"XDG_CONFIG_HOME",
		]);
	});

	test("language-manager, Go, Rust, display, editor and CA-dir names pass", () => {
		const names = [
			"PYENV_ROOT",
			"ASDF_DIR",
			"ASDF_DATA_DIR",
			"GOPATH",
			"GOROOT",
			"CARGO_HOME",
			"RUSTUP_HOME",
			"DISPLAY",
			"WAYLAND_DISPLAY",
			"EDITOR",
			"SSL_CERT_DIR",
			"CURL_CA_BUNDLE",
		];
		const e = buildChildEnv(Object.fromEntries(names.map((n) => [n, "/v"])));
		expect(Object.keys(e).sort()).toEqual([...names].sort());
	});

	test("DOCKER_HOST follows the userinfo rule", () => {
		expect(buildChildEnv({ DOCKER_HOST: "tcp://u:p@h:2375" }).DOCKER_HOST).toBeUndefined();
		expect(buildChildEnv({ DOCKER_HOST: "unix:///var/run/docker.sock" }).DOCKER_HOST).toBe(
			"unix:///var/run/docker.sock",
		);
		expect(buildChildEnv({ DOCKER_HOST: "tcp://h:2375" }).DOCKER_HOST).toBe("tcp://h:2375");
	});

	test("XDG is a named list, not a wildcard", () => {
		const e = buildChildEnv({
			XDG_APIKEY: "k",
			XDG_STUFF_PASSWD: "p",
			XDG_STUFF: "s",
			XDG_RUNTIME_DIR: "/r",
			XDG_DATA_DIRS: "/d",
		});
		expect(Object.keys(e).sort()).toEqual(["XDG_DATA_DIRS", "XDG_RUNTIME_DIR"]);
	});

	test("no default name matches the secret pattern", () => {
		for (const n of BASE_NAMES) expect(SECRETISH.test(n)).toBe(false);
		for (const n of ["MY_PASSPHRASE", "CLOUD_CREDENTIALS", "X_AUTH", "APIKEY", "DB_PASSWD"])
			expect(buildChildEnv({ [n]: "v" })[n]).toBeUndefined();
	});

	test("proxy with credentials is dropped, without is kept, either case", () => {
		const e = buildChildEnv({
			HTTP_PROXY: "http://user:pw@proxy:3128",
			https_proxy: "http://proxy:3128",
			NO_PROXY: "localhost",
			ALL_PROXY: "user:pw@proxy:1080",
		});
		expect(e.HTTP_PROXY).toBeUndefined();
		expect(e.ALL_PROXY).toBeUndefined();
		expect(e.https_proxy).toBe("http://proxy:3128");
		expect(e.NO_PROXY).toBe("localhost");
	});

	test("credential-looking names never pass by default, even under an allowed prefix", () => {
		const e = buildChildEnv({
			XDG_API_TOKEN: "t",
			XDG_SERVICE_KEY: "k",
			NODE_ENV_SECRET: "s",
			JAVA_HOME_PASSWORD: "p",
			XDG_AUTH_FILE: "a",
			XDG_DATA_HOME: "/d",
		});
		expect(Object.keys(e)).toEqual(["XDG_DATA_HOME"]);
	});

	test("SSH_AUTH_SOCK is not a default; opt-in passes it", () => {
		expect(buildChildEnv({ SSH_AUTH_SOCK: "/s" }).SSH_AUTH_SOCK).toBeUndefined();
		expect(
			buildChildEnv({ SSH_AUTH_SOCK: "/s", EIGHT_SHELL_ENV_PASS: "SSH_AUTH_SOCK" }).SSH_AUTH_SOCK,
		).toBe("/s");
	});

	test("withheldAny reports a filtered variable without naming it", () => {
		expect(withheldAny({ PATH: "/bin" })).toBe(false);
		expect(withheldAny({ PATH: "/bin", FOO_TOKEN: "x" })).toBe(true);
	});
});

describe("failure hint", () => {
	test("appended once per session on a non-zero exit, never with names or values", async () => {
		const first = await run("false");
		expect(first).toContain("EIGHT_SHELL_ENV_PASS");
		expect(first).not.toContain("FAKE_SECRET_KEY");
		expect(first).not.toContain(CANARY);
		const second = await run("false");
		expect(second).not.toContain("EIGHT_SHELL_ENV_PASS");
	});

	test("no hint on success", async () => {
		expect(await run("true")).not.toContain("EIGHT_SHELL_ENV_PASS");
	});
});
