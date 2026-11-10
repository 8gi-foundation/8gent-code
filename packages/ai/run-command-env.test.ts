/**
 * run_command hands a child process an allowlisted environment (#95).
 *
 * Before the fix the shell path and the argv path both spread process.env into the
 * child, so a turn running `env` printed the daemon's TELEGRAM_BOT_TOKEN and every
 * provider key. These tests call the real run_command and git tools with fake
 * secrets planted in the parent process.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fakeExecutable } from "../../tests/fake-exe";
import { getPermissionManager, resetPermissionManager } from "../permissions";
import { refreshSecurityEnvForTests } from "../permissions/run-command-sandbox";
import { agentTools, setToolContext } from "./tools";

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "run-command-env-")));
const PLANTED: Record<string, string> = {
	TELEGRAM_BOT_TOKEN: "tg-fake-1111:AAAA-planted",
	TELEGRAM_CHAT_ID: "424242",
	OPENROUTER_API_KEY: "sk-or-planted",
	ANTHROPIC_API_KEY: "sk-ant-planted",
	GROQ_API_KEY: "gsk-planted",
	DB_PASSWORD: "hunter2-planted",
	SOME_SECRET: "s3cr3t-planted",
	EIGHT_TEST_PLAIN: "plain-value-planted",
};
const saved: Record<string, string | undefined> = {};
const TOUCHED = [...Object.keys(PLANTED), "PATH", "EIGHT_DATA_DIR", "EIGHT_SYSTEM_ONE", "EIGHT_FAKE_HOME"];
let argvLog = "";

type Exec = (input: unknown, options: unknown) => Promise<string>;
function call(name: keyof typeof agentTools, input: Record<string, unknown> = {}): Promise<string> {
	const run = agentTools[name].execute as unknown as Exec;
	return run(input, { toolCallId: "t", messages: [] });
}

beforeAll(() => {
	for (const k of TOUCHED) saved[k] = process.env[k];
	Object.assign(process.env, PLANTED);
	process.env.EIGHT_DATA_DIR = path.join(scratch, "data");
	process.env.EIGHT_SYSTEM_ONE = "0";
	const fakeHome = path.join(scratch, "home");
	fs.mkdirSync(fakeHome, { recursive: true });
	process.env.EIGHT_FAKE_HOME = fakeHome;
	refreshSecurityEnvForTests();

	// A stand-in gh that dumps the environment it was started with.
	const bin = path.join(scratch, "bin");
	fs.mkdirSync(bin);
	argvLog = path.join(scratch, "gh-env.json");
	fakeExecutable(
		bin,
		"gh",
		`require("node:fs").writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.env));\nconsole.log("ok");\n`,
	);
	process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;

	const work = path.join(scratch, "work");
	fs.mkdirSync(work);
	resetPermissionManager();
	const pm = getPermissionManager();
	pm.enableInfiniteMode();
	pm.requestPermission = async () => true;
	setToolContext({ workingDirectory: work });
});

afterAll(() => {
	resetPermissionManager();
	for (const k of TOUCHED) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	refreshSecurityEnvForTests();
	fs.rmSync(scratch, { recursive: true, force: true });
});

describe("run_command shell path (#95)", () => {
	test("a spawned `env` does not contain planted secrets", async () => {
		const out = await call("run_command", { command: "env" });
		expect(out).toContain("PATH=");
		for (const [name, value] of Object.entries(PLANTED)) {
			if (name === "EIGHT_TEST_PLAIN") continue;
			expect(out).not.toContain(name);
			expect(out).not.toContain(value);
		}
	});

	test("allowlisted variables still pass through", async () => {
		const out = await call("run_command", { command: "env" });
		expect(out).toContain(`HOME=${process.env.HOME}`);
		expect(out).toContain("PATH=");
		expect(out).not.toContain("EIGHT_TEST_PLAIN");
	});

	test("printenv of a secret by name prints nothing", async () => {
		const out = await call("run_command", { command: "printenv TELEGRAM_BOT_TOKEN" });
		expect(out).not.toContain(PLANTED.TELEGRAM_BOT_TOKEN);
	});
});

describe("run_command argv path (gh) (#95)", () => {
	test("gh does not receive the planted secrets, only its own credential names", async () => {
		process.env.GH_TOKEN = "gh-planted-token";
		try {
			await call("gh_pr_list");
			const seen = JSON.parse(fs.readFileSync(argvLog, "utf8")) as Record<string, string>;
			expect(seen.TELEGRAM_BOT_TOKEN).toBeUndefined();
			expect(seen.OPENROUTER_API_KEY).toBeUndefined();
			expect(seen.ANTHROPIC_API_KEY).toBeUndefined();
			expect(seen.DB_PASSWORD).toBeUndefined();
			expect(seen.GH_TOKEN).toBe("gh-planted-token");
			expect(seen.PATH).toBeDefined();
		} finally {
			delete process.env.GH_TOKEN;
		}
	});
});
