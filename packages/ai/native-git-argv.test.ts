/**
 * Native git and gh tools run as argv, never through a shell (#3998).
 *
 * Before the fix packages/ai/tools.ts pasted model arguments into a shell
 * string (`git checkout ${branch}`), so a branch like `x; cat ~/.ssh/id_rsa`
 * ran the second command. Each tool now spawns the binary with an args array:
 * every metacharacter below must reach git or gh as plain text, and a value
 * shaped like an option must be refused or put after `--`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getPermissionManager, resetPermissionManager } from "../permissions";
import { agentTools, argvDisplay, optionRefusal, setToolContext } from "./tools";

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-git-argv-")));
const saved = {
	PATH: process.env.PATH,
	EIGHT_DATA_DIR: process.env.EIGHT_DATA_DIR,
	EIGHT_SYSTEM_ONE: process.env.EIGHT_SYSTEM_ONE,
};

// Each payload would create MARK through a shell. Through argv it is just text.
const MARK = path.join(scratch, "PWNED");
const PAYLOADS = [
	`x; touch ${MARK}`,
	`x$(touch ${MARK})`,
	`x\`touch ${MARK}\``,
	`x | touch ${MARK}`,
	`x\ntouch ${MARK}`,
	`x && touch ${MARK}`,
];

let repo = "";
let ghLog = "";

type Exec = (input: unknown, options: unknown) => Promise<string>;
function call(name: keyof typeof agentTools, input: Record<string, unknown> = {}): Promise<string> {
	const run = agentTools[name].execute as unknown as Exec;
	return run(input, { toolCallId: "t", messages: [] });
}

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

beforeAll(() => {
	process.env.EIGHT_DATA_DIR = path.join(scratch, "data");
	process.env.EIGHT_SYSTEM_ONE = "0";
	process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Test";
	process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "test@example.invalid";

	// A stand-in gh that records each argv word on its own NUL-separated line.
	const bin = path.join(scratch, "bin");
	fs.mkdirSync(bin);
	ghLog = path.join(scratch, "gh-argv");
	fs.writeFileSync(
		path.join(bin, "gh"),
		`#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done > "${ghLog}"\necho ok\n`,
		{ mode: 0o755 },
	);
	process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;

	repo = path.join(scratch, "repo");
	fs.mkdirSync(repo);
	git("init", "-q", "-b", "main");
	fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
	git("add", "a.txt");
	git("commit", "-q", "-m", "init");

	resetPermissionManager();
	const pm = getPermissionManager();
	pm.enableInfiniteMode();
	// A human says yes to every card: gh create sends data and always asks.
	pm.requestPermission = async () => true;
	setToolContext({ workingDirectory: repo });
});

afterAll(() => {
	resetPermissionManager();
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	fs.rmSync(scratch, { recursive: true, force: true });
});

function ghArgv(): string[] {
	return fs.readFileSync(ghLog, "utf8").split("\0").slice(0, -1);
}

describe("shell metacharacters are passed literally (#3998)", () => {
	beforeEach(() => fs.rmSync(MARK, { force: true }));

	for (const payload of PAYLOADS) {
		const label = JSON.stringify(payload);

		test(`git_checkout ${label}`, async () => {
			await call("git_checkout", { branch: payload });
			expect(fs.existsSync(MARK)).toBe(false);
		});

		test(`git_create_branch ${label}`, async () => {
			await call("git_create_branch", { branch: payload });
			expect(fs.existsSync(MARK)).toBe(false);
			git("checkout", "-q", "main");
		});

		test(`git_add ${label}`, async () => {
			await call("git_add", { files: payload });
			expect(fs.existsSync(MARK)).toBe(false);
		});

		test(`git_commit ${label}`, async () => {
			fs.appendFileSync(path.join(repo, "a.txt"), "x\n");
			git("add", "a.txt");
			await call("git_commit", { message: payload });
			expect(fs.existsSync(MARK)).toBe(false);
			expect(git("log", "-1", "--format=%B")).toBe(payload.trim());
		});

		test(`gh_pr_create ${label}`, async () => {
			await call("gh_pr_create", { title: payload, body: payload });
			expect(fs.existsSync(MARK)).toBe(false);
			expect(ghArgv()).toEqual(["pr", "create", "--title", payload, "--body", payload]);
		});

		test(`gh_issue_create ${label}`, async () => {
			await call("gh_issue_create", { title: payload, body: payload, assignee: payload });
			expect(fs.existsSync(MARK)).toBe(false);
			expect(ghArgv()).toEqual([
				"issue",
				"create",
				"--title",
				payload,
				"--body",
				payload,
				"--assignee",
				payload,
			]);
		});
	}

	test("argument-free tools run the fixed argv", async () => {
		await call("gh_pr_list");
		expect(ghArgv()).toEqual(["pr", "list"]);
		await call("gh_issue_list");
		expect(ghArgv()).toEqual(["issue", "list"]);
		await call("gh_pr_view", { number: 12 });
		expect(ghArgv()).toEqual(["pr", "view", "12"]);
		await call("gh_pr_view", {});
		expect(ghArgv()).toEqual(["pr", "view"]);
	});
});

describe("option injection is refused or neutralised (#3998)", () => {
	const sshMark = path.join(scratch, "SSH_RAN");
	const injections = ["--upload-pack=x", `-c core.sshCommand=touch ${sshMark}`, "-ftouch"];

	for (const value of injections) {
		test(`git_checkout refuses ${JSON.stringify(value)}`, async () => {
			const out = await call("git_checkout", { branch: value });
			expect(out).toContain("[BLOCKED]");
			expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
		});

		test(`git_create_branch refuses ${JSON.stringify(value)}`, async () => {
			const out = await call("git_create_branch", { branch: value });
			expect(out).toContain("[BLOCKED]");
			expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
		});
	}

	test("git_add puts every word after --, so options become pathspecs", async () => {
		const out = await call("git_add", { files: `-c core.sshCommand=touch${sshMark} --dry-run` });
		expect(out).toMatch(/did not match any files/);
		expect(fs.existsSync(sshMark)).toBe(false);
	});

	test("optionRefusal and argvDisplay", () => {
		expect(optionRefusal("Branch", "feature/x")).toBeNull();
		expect(optionRefusal("Branch", "--upload-pack=x")).toContain("[BLOCKED]");
		expect(argvDisplay("git", ["commit", "-m", "it's $(x)"])).toBe(`git commit -m 'it'\\''s $(x)'`);
	});
});

describe("normal operations still work against a real repo", () => {
	test("status, add, commit, log, branch, create, checkout, diff", async () => {
		git("checkout", "-q", "main");
		fs.writeFileSync(path.join(repo, "b file.txt"), "b\n");
		fs.writeFileSync(path.join(repo, "c.txt"), "c\n");

		expect(await call("git_status")).toContain("c.txt");
		await call("git_add", { files: "c.txt" });
		expect(git("diff", "--cached", "--name-only")).toBe("c.txt");
		expect(await call("git_diff", { staged: true })).toContain("+c");

		expect(await call("git_commit", { message: "add c" })).toContain("add c");
		expect(await call("git_log", { count: 1 })).toContain("add c");

		await call("git_add", {});
		expect(git("diff", "--cached", "--name-only")).toBe("b file.txt");
		git("commit", "-q", "-m", "add b");

		await call("git_create_branch", { branch: "feature/argv" });
		expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/argv");
		expect(await call("git_branch")).toContain("feature/argv");
		await call("git_checkout", { branch: "main" });
		expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");

		fs.appendFileSync(path.join(repo, "c.txt"), "more\n");
		expect(await call("git_diff")).toContain("+more");
	});

	test("git_push with setUpstream pushes a branch to a remote", async () => {
		const remote = path.join(scratch, "remote.git");
		execFileSync("git", ["init", "-q", "--bare", remote]);
		git("remote", "add", "origin", remote);
		git("checkout", "-q", "feature/argv");
		await call("git_push", { setUpstream: true });
		const pushed = execFileSync("git", ["--git-dir", remote, "branch"], { encoding: "utf8" });
		expect(pushed).toContain("feature/argv");
		git("checkout", "-q", "main");
	});
});
