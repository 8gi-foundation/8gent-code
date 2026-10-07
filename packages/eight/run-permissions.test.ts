/**
 * `8gent run` permission setup: --yes is in memory for the run only, and a
 * --yes or stream-json run never prompts (it denies instead). The last block
 * drives the real run_command path against a local bare remote.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { getPermissionManager, resetPermissionManager } from "../permissions";
import { SYSTEM_ONE_FLAG } from "../permissions/system-one-gate";
import { _resetTuiApprovalChannel } from "../permissions/tui-approval-channel";
import { applyRunPermissions } from "./run";
import { ToolExecutor } from "./tools";

afterAll(cleanupTempDirs);

const ENV_KEYS = ["EIGHT_DATA_DIR", "EIGHT_HEADLESS", SYSTEM_ONE_FLAG];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
let dataDir = "";

beforeEach(() => {
	dataDir = tempDir("run-perms-data-");
	process.env.EIGHT_DATA_DIR = dataDir;
	process.env[SYSTEM_ONE_FLAG] = "0";
	Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
	_resetTuiApprovalChannel();
	resetPermissionManager();
});
afterEach(() => {
	resetPermissionManager();
	if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = savedEnv[k];
	}
});

function setTty(value: boolean): void {
	Object.defineProperty(process.stdin, "isTTY", { value, configurable: true, writable: true });
}

describe("run --yes", () => {
	test("auto-approves in memory and leaves permissions.json without autoApprove", async () => {
		const configPath = join(dataDir, "permissions.json");
		await applyRunPermissions({ yes: true, outputFormat: "text" });
		expect(await getPermissionManager().requestPermission("x", "y", "make build")).toBe(true);
		expect(existsSync(configPath)).toBe(false);
	});

	test("an existing permissions.json is left byte for byte", async () => {
		const configPath = join(dataDir, "permissions.json");
		const before = JSON.stringify({
			allowedPatterns: ["ls *"],
			deniedPatterns: [],
			autoApprove: false,
		});
		writeFileSync(configPath, before);
		await applyRunPermissions({ yes: true, outputFormat: "stream-json" });
		getPermissionManager().allowPattern("make *"); // a later save must not carry the run's auto-approve
		expect(JSON.parse(readFileSync(configPath, "utf-8")).autoApprove).toBe(false);
		resetPermissionManager();
		expect(getPermissionManager().getConfig().autoApprove).toBe(false);
	});
});

describe("stream-json under a TTY", () => {
	test("a dangerous command is denied without writing a prompt to stdout", async () => {
		setTty(true);
		await applyRunPermissions({ yes: false, outputFormat: "stream-json" });
		const writes: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			const answer = await Promise.race([
				getPermissionManager().requestPermission("x", "y", "chmod 777 build"),
				new Promise<string>((r) => setTimeout(() => r("prompted"), 1000)),
			]);
			expect(answer).toBe(false);
		} finally {
			process.stdout.write = orig;
		}
		expect(writes.join("")).not.toContain("PERMISSION REQUIRED");
		expect(writes.join("")).not.toContain("Allow?");
	});
});

describe("run_command against a local bare remote", () => {
	function git(cwd: string, ...args: string[]): string {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	}
	function world(): { work: string; remote: string; mainSha: string } {
		const root = tempDir("run-perms-git-");
		const remote = join(root, "remote.git");
		const work = join(root, "work");
		execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "ignore" });
		execFileSync("git", ["clone", remote, work], { stdio: "ignore" });
		git(work, "config", "user.email", "test@example.invalid");
		git(work, "config", "user.name", "test");
		git(work, "checkout", "-b", "main");
		writeFileSync(join(work, "a.txt"), "one\n");
		git(work, "add", "a.txt");
		git(work, "commit", "-m", "one");
		git(work, "push", "origin", "main");
		const mainSha = git(remote, "rev-parse", "main");
		writeFileSync(join(work, "a.txt"), "two\n");
		git(work, "commit", "-am", "two");
		return { work, remote, mainSha };
	}

	for (const [label, opts] of [
		["headless (no TTY)", { yes: false, tty: false }],
		["--yes", { yes: true, tty: false }],
		["--yes under a TTY", { yes: true, tty: true }],
	] as const) {
		test(`${label}: protected pushes are refused, main does not move`, async () => {
			setTty(opts.tty);
			if (opts.yes) await applyRunPermissions({ yes: true, outputFormat: "text" });
			const { work, remote, mainSha } = world();
			const exec = new ToolExecutor(work, "run-perms-test");
			for (const command of [
				"git push origin main",
				"git push origin HEAD:main",
				"git push origin HEAD:refs/heads/main",
				"git push origin HEAD:master",
			]) {
				const out = String(await exec.execute("run_command", { command }));
				expect(out).toContain("[PERMISSION DENIED]");
				expect(out).toContain("protected branch");
			}
			expect(git(remote, "rev-parse", "main")).toBe(mainSha);
			expect(() => git(remote, "rev-parse", "--verify", "master")).toThrow();
		});
	}

	test("--yes: a feature-branch push still goes through; force push is still blocked", async () => {
		setTty(false);
		await applyRunPermissions({ yes: true, outputFormat: "text" });
		const { work, remote, mainSha } = world();
		const exec = new ToolExecutor(work, "run-perms-test");
		await exec.execute("run_command", { command: "git push origin HEAD:feat/x" });
		expect(git(remote, "rev-parse", "feat/x")).toBe(git(work, "rev-parse", "HEAD"));
		const forced = String(
			await exec.execute("run_command", { command: "git push --force origin HEAD:feat/y" }),
		);
		expect(forced).not.toContain("Exit code: 0");
		expect(() => git(remote, "rev-parse", "--verify", "feat/y")).toThrow();
		expect(git(remote, "rev-parse", "main")).toBe(mainSha);
	});
});
