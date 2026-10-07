/**
 * The real tool paths (run_command, background_start, git_push) against a
 * local bare remote: pushes that land on main without naming it, and the
 * shell forms that hide the branch name, are refused when no one can
 * approve them, and main does not move. Feature-branch pushes still land.
 * Throwaway HOME and data dir; no network.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { getPermissionManager, resetPermissionManager } from "../permissions";
import { resetMakerCheckerEnforcer } from "../permissions/maker-checker-enforcer";
import { SYSTEM_ONE_FLAG } from "../permissions/system-one-gate";
import {
	_resetTuiApprovalChannel,
	registerTuiApprovalHandler,
} from "../permissions/tui-approval-channel";
import { getBackgroundTaskManager } from "../tools/background";
import { applyRunPermissions } from "./run";
import { ToolExecutor } from "./tools";

afterAll(cleanupTempDirs);

const ENV_KEYS = [
	"HOME",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_NOSYSTEM",
	"EIGHT_DATA_DIR",
	"EIGHT_HEADLESS",
	"EIGHT_ENFORCE_CHECKER",
	SYSTEM_ONE_FLAG,
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

beforeEach(() => {
	const home = tempDir("push-res-home-");
	process.env.HOME = home;
	process.env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	process.env.EIGHT_DATA_DIR = tempDir("push-res-data-");
	process.env[SYSTEM_ONE_FLAG] = "0";
	Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
	Reflect.deleteProperty(process.env, "EIGHT_ENFORCE_CHECKER");
	_resetTuiApprovalChannel();
	resetPermissionManager();
	resetMakerCheckerEnforcer();
	setTty(false);
});
afterEach(() => {
	_resetTuiApprovalChannel();
	resetPermissionManager();
	if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
	else Reflect.deleteProperty(process.stdin, "isTTY");
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = savedEnv[k];
	}
});

function setTty(value: boolean): void {
	Object.defineProperty(process.stdin, "isTTY", { value, configurable: true, writable: true });
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

/** A clone on main tracking origin/main, one commit ahead of the remote. */
function world(): { work: string; remote: string; mainSha: string } {
	const root = tempDir("push-res-git-");
	const remote = join(root, "remote.git");
	const work = join(root, "work");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
	execFileSync("git", ["clone", "-q", remote, work], { stdio: "ignore" });
	git(work, "config", "user.email", "test@example.invalid");
	git(work, "config", "user.name", "test");
	git(work, "checkout", "-q", "-b", "main");
	writeFileSync(join(work, "a.txt"), "one\n");
	git(work, "add", "a.txt");
	git(work, "commit", "-q", "-m", "one");
	git(work, "push", "-q", "-u", "origin", "main");
	const mainSha = git(remote, "rev-parse", "main");
	writeFileSync(join(work, "a.txt"), "two\n");
	git(work, "commit", "-q", "-am", "two");
	// A repository alias the model could have written earlier in the session.
	git(work, "config", "alias.p", "push");
	return { work, remote, mainSha };
}

/** Every one of these lands on main from a checkout of main, if let through. */
const ON_MAIN = [
	"git push",
	"git push origin",
	"git push origin HEAD",
	"git push -u origin HEAD",
	"git push origin @",
	'git push origin ma""in',
	"git push origin ma'i'n",
	"git push origin m\\ain",
	"git push origin \\\nmain",
	"git push origin main>/dev/null",
	"echo main | xargs git push origin",
	"git -c alias.q=push q origin main",
	"git --config-env core.x=HOME push origin main",
	"git -c remote.origin.push=HEAD:refs/heads/main push origin",
	"git p origin main",
	"git p",
];

function refused(out: string): boolean {
	return out.includes("[PERMISSION DENIED]") || out.includes("[BLOCKED]");
}

describe("run_command, no one to approve", () => {
	for (const [label, yes] of [
		["headless", false],
		["--yes", true],
	] as const) {
		test(`${label}: pushes that land on main are refused and main does not move`, async () => {
			if (yes) await applyRunPermissions({ yes: true, outputFormat: "text" });
			const { work, remote, mainSha } = world();
			const exec = new ToolExecutor(work, "push-res-test");
			for (const command of ON_MAIN) {
				expect(getPermissionManager().checkPermission(command, work)).toBe("denied");
				const out = String(await exec.execute("run_command", { command }));
				if (!refused(out)) throw new Error(`not refused: ${JSON.stringify(command)}\n${out}`);
				expect(git(remote, "rev-parse", "main")).toBe(mainSha);
			}
		});
	}

	test("a feature branch: bare and HEAD pushes still land, main does not move", async () => {
		await applyRunPermissions({ yes: true, outputFormat: "text" });
		const { work, remote, mainSha } = world();
		git(work, "checkout", "-q", "-b", "feat/w");
		const exec = new ToolExecutor(work, "push-res-test");
		await exec.execute("run_command", { command: "git push -u origin HEAD" });
		expect(git(remote, "rev-parse", "feat/w")).toBe(git(work, "rev-parse", "HEAD"));
		writeFileSync(join(work, "a.txt"), "three\n");
		git(work, "commit", "-q", "-am", "three");
		await exec.execute("run_command", { command: "git push" });
		expect(git(remote, "rev-parse", "feat/w")).toBe(git(work, "rev-parse", "HEAD"));
		expect(git(remote, "rev-parse", "main")).toBe(mainSha);
	});
});

describe("background_start, no one to approve", () => {
	test("bare, HEAD and xargs pushes on main are refused; a feature push runs", async () => {
		const { work, remote, mainSha } = world();
		const exec = new ToolExecutor(work, "push-res-test");
		for (const command of [
			"git push",
			"git push origin HEAD",
			"echo main | xargs git push origin",
		]) {
			const out = String(await exec.execute("background_start", { command }));
			expect(out).toContain("[PERMISSION DENIED]");
			expect(out).not.toContain("Background task started");
		}
		git(work, "checkout", "-q", "-b", "feat/bg");
		const started = String(
			await exec.execute("background_start", { command: "git push -u origin HEAD" }),
		);
		const taskId = started.match(/Background task started: (\S+)/)?.[1];
		expect(taskId).toBeTruthy();
		await getBackgroundTaskManager().waitForTask(taskId as string, 20_000);
		expect(git(remote, "rev-parse", "feat/bg")).toBe(git(work, "rev-parse", "HEAD"));
		expect(git(remote, "rev-parse", "main")).toBe(mainSha);
	});
});

describe("git_push tool", () => {
	for (const [label, opts] of [
		["headless", { yes: false, unattended: false }],
		["--yes", { yes: true, unattended: false }],
		["--yes, unattended (maker-checker on)", { yes: true, unattended: true }],
	] as const) {
		test(`${label}: on main it is refused and main does not move`, async () => {
			if (opts.yes) await applyRunPermissions({ yes: true, outputFormat: "text" });
			const { work, remote, mainSha } = world();
			const exec = new ToolExecutor(work, "push-res-test", undefined, {
				unattended: opts.unattended,
			});
			for (const args of [{}, { setUpstream: true }]) {
				const out = String(await exec.execute("git_push", args));
				if (!out.includes("[PERMISSION DENIED]") && !out.includes("[MAKER-CHECKER BLOCKED]"))
					throw new Error(`not refused: ${JSON.stringify(args)}\n${out}`);
				if (opts.unattended) expect(out).toContain("(destructive)");
				expect(git(remote, "rev-parse", "main")).toBe(mainSha);
			}
		});
	}

	test("detached HEAD: refused, the branch cannot be worked out", async () => {
		const { work, remote, mainSha } = world();
		git(work, "checkout", "-q", "--detach");
		const exec = new ToolExecutor(work, "push-res-test");
		const out = String(await exec.execute("git_push", { setUpstream: true }));
		expect(out).toContain("[PERMISSION DENIED]");
		expect(git(remote, "rev-parse", "main")).toBe(mainSha);
	});

	test("a feature branch still pushes, with and without setUpstream", async () => {
		await applyRunPermissions({ yes: true, outputFormat: "text" });
		const { work, remote, mainSha } = world();
		git(work, "checkout", "-q", "-b", "feat/tool");
		const exec = new ToolExecutor(work, "push-res-test");
		await exec.execute("git_push", { setUpstream: true });
		expect(git(remote, "rev-parse", "feat/tool")).toBe(git(work, "rev-parse", "HEAD"));
		writeFileSync(join(work, "a.txt"), "four\n");
		git(work, "commit", "-q", "-am", "four");
		await exec.execute("git_push", {});
		expect(git(remote, "rev-parse", "feat/tool")).toBe(git(work, "rev-parse", "HEAD"));
		expect(git(remote, "rev-parse", "main")).toBe(mainSha);
	});

	test("interactive: one card per push to main, and the answer is honoured", async () => {
		setTty(true);
		const { work, remote, mainSha } = world();
		const cards: string[] = [];
		let answer: "approve" | "deny" = "deny";
		registerTuiApprovalHandler(async (req) => {
			cards.push(req.command ?? "");
			return answer;
		});
		const exec = new ToolExecutor(work, "push-res-test");
		const denied = String(await exec.execute("git_push", {}));
		expect(denied).toContain("[PERMISSION DENIED]");
		expect(git(remote, "rev-parse", "main")).toBe(mainSha);
		answer = "approve";
		await exec.execute("git_push", {});
		expect(git(remote, "rev-parse", "main")).toBe(git(work, "rev-parse", "HEAD"));
		expect(cards).toEqual(["git push", "git push"]);
	});
});

describe("commands that change the repository before they push", () => {
	test("background_start: checkout main then a bare push is refused, main does not move", async () => {
		await applyRunPermissions({ yes: true, outputFormat: "text" });
		const { work, remote, mainSha } = world();
		git(work, "checkout", "-q", "-b", "feat/seq");
		git(work, "push", "-q", "-u", "origin", "HEAD");
		const exec = new ToolExecutor(work, "push-res-test");
		for (const command of [
			"git checkout -q main && git push",
			"git switch -q main; git push origin HEAD",
			"git -c push.default=matching push origin",
		]) {
			const out = String(await exec.execute("background_start", { command }));
			expect(out).toContain("[PERMISSION DENIED]");
		}
		expect(git(work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/seq");
		expect(git(remote, "rev-parse", "main")).toBe(mainSha);
	});
});

describe("spawn_agent runtime shell, no one to approve", () => {
	async function settle(remote: string, ref: string): Promise<string> {
		for (let i = 0; i < 100; i++) {
			try {
				return git(remote, "rev-parse", "--verify", ref);
			} catch {
				await new Promise((r) => setTimeout(r, 100));
			}
		}
		return "";
	}

	test("a push to main is refused and main does not move; a feature push still runs", async () => {
		await applyRunPermissions({ yes: true, outputFormat: "text" });
		const { work, remote, mainSha } = world();
		const exec = new ToolExecutor(work, "push-res-test");
		for (const task of ["git push origin main", "git push", "git checkout -q main && git push"]) {
			const out = String(await exec.execute("spawn_agent", { runtime: "shell", task }));
			expect(out).toContain("[PERMISSION DENIED]");
		}
		git(work, "checkout", "-q", "-b", "feat/shell");
		const started = String(
			await exec.execute("spawn_agent", { runtime: "shell", task: "git push -u origin HEAD" }),
		);
		expect(started).toContain("spawned and running");
		expect(await settle(remote, "feat/shell")).toBe(git(work, "rev-parse", "HEAD"));
		expect(git(remote, "rev-parse", "main")).toBe(mainSha);
	});
});

describe("the process runs outside the repository", () => {
	const savedCwd = process.cwd();
	afterEach(() => process.chdir(savedCwd));

	test("feature pushes resolve in the tool's directory, not the process's", async () => {
		await applyRunPermissions({ yes: true, outputFormat: "text" });
		const { work, remote, mainSha } = world();
		git(work, "checkout", "-q", "-b", "feat/elsewhere");
		process.chdir(tempDir("push-res-notrepo-"));
		const exec = new ToolExecutor(work, "push-res-test");
		const out = String(await exec.execute("run_command", { command: "git push -u origin HEAD" }));
		expect(out).not.toContain("[PERMISSION DENIED]");
		expect(git(remote, "rev-parse", "feat/elsewhere")).toBe(git(work, "rev-parse", "HEAD"));
		await exec.execute("git_push", {});
		expect(git(remote, "rev-parse", "main")).toBe(mainSha);
	});
});
