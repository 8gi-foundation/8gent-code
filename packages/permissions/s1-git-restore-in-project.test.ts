/**
 * #3840: System One must not block restoring a tracked file from git history.
 *
 * The pilot case (troubleshoot-practice, 10 Oct 2026): `git show 906ce37:config/rates.json
 * > config/rates.json` was blocked by the judge (pYes 0.5082). The judge here is a stub
 * that answers "dangerous" to everything, so a command that reaches it is blocked. A
 * command the new lane passes never reaches it; every negative must still reach it.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { restoreInProject } from "./s1-git-restore-in-project";
import {
	SYSTEM_ONE_ALLOWLIST_FLAG,
	SYSTEM_ONE_BLOCK_MARKER,
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
	systemOneGate,
} from "./system-one-gate";

afterAll(cleanupTempDirs);

class AlwaysDangerous implements DecideBackend {
	readonly name = "stub";
	readonly model = "always-dangerous";
	asks = 0;
	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		this.asks++;
		return {
			answers: [
				{
					id: request.questions[0].id,
					kind: "noul",
					probabilities: { yes: 0.99 },
					confidence: 0.99,
				},
			],
			backend: this.name,
			model: this.model,
			latencyMs: 0,
		};
	}
}

let ws: string;
let outside: string;
let sha: string;
let judge: AlwaysDangerous;
const saved: Record<string, string | undefined> = {};
const KEYS = [SYSTEM_ONE_FLAG, SYSTEM_ONE_ALLOWLIST_FLAG, "EIGHT_HEADLESS", "EIGHT_WORKSPACE_ROOT"];

function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
		{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	).trim();
}

beforeAll(() => {
	for (const k of KEYS) saved[k] = process.env[k];
	Reflect.deleteProperty(process.env, "EIGHT_WORKSPACE_ROOT");
	Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
	process.env.EIGHT_HEADLESS = "1";
});

afterAll(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = saved[k];
	}
	_resetSystemOne();
});

beforeEach(() => {
	ws = tempDir("s1-restore-ws-");
	outside = tempDir("s1-restore-out-");
	git(ws, "init", "-q");
	mkdirSync(join(ws, "config"));
	mkdirSync(join(ws, "packages", "permissions"), { recursive: true });
	writeFileSync(join(ws, "config", "rates.json"), '{"rate":1}');
	writeFileSync(join(ws, "config", "other.json"), "{}");
	writeFileSync(join(ws, "server.key"), "k");
	writeFileSync(join(ws, ".env"), "S=1");
	writeFileSync(join(ws, "packages", "permissions", "policy.ts"), "x");
	writeFileSync(join(outside, "victim.txt"), "x");
	symlinkSync(join(outside, "victim.txt"), join(ws, "config", "link.json"));
	git(ws, "add", "-A", "-f");
	git(ws, "commit", "-q", "-m", "good");
	sha = git(ws, "rev-parse", "--short", "HEAD");
	writeFileSync(join(ws, "config", "rates.json"), '{"rate":"broken"}');
	git(ws, "commit", "-qam", "bad");
	writeFileSync(join(ws, "untracked.txt"), "u");
	judge = new AlwaysDangerous();
	_setSystemOneOverridesForTests({
		createDecider: () => createDecider({ backend: judge, cacheSize: 0 }),
		askHuman: async () => null,
		calibrationDir: tempDir("s1-restore-nocal-"),
	});
	process.env[SYSTEM_ONE_FLAG] = "1";
});

afterEach(() => {
	rmSync(ws, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
	Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
});

describe("restoreInProject allows", () => {
	const allowed = (): string[] => [
		`git show ${sha}:config/rates.json > config/rates.json`,
		`git show HEAD~1:config/rates.json > config/rates.json`,
		`git show ${sha}:./config/rates.json > ./config/rates.json`,
		"git restore config/rates.json",
		"git restore -- config/rates.json",
		`git restore --source=${sha} config/rates.json`,
		`git restore --source=HEAD~1 -- config/rates.json config/other.json`,
		"git checkout -- config/rates.json",
		`git checkout ${sha} -- config/rates.json`,
		"git checkout HEAD -- config/rates.json config/other.json",
	];
	test("every shape, including the exact pilot command", () => {
		for (const cmd of allowed()) expect([cmd, restoreInProject(cmd, ws).ok]).toEqual([cmd, true]);
	});
});

describe("restoreInProject falls through on", () => {
	const refused = (): Array<[string, string]> => [
		["a redirect outside the tree", `git show ${sha}:config/rates.json > /etc/x`],
		["a redirect to another path", `git show ${sha}:config/rates.json > config/other.json`],
		["an append", `git show ${sha}:config/rates.json >> config/rates.json`],
		["a redirect to a dotfile", `git show ${sha}:config/rates.json > .env`],
		["a redirect through ..", `git show ${sha}:config/rates.json > ../rates.json`],
		["a target with uncommitted edits", "@DIRTY"],
		["an untracked target", "git restore untracked.txt"],
		["an untracked show target", `git show ${sha}:untracked.txt > untracked.txt`],
		["a missing target", "git restore config/nope.json"],
		["a symlinked target", "git restore config/link.json"],
		["a symlinked show target", `git show ${sha}:config/link.json > config/link.json`],
		["a target outside with ..", "git restore ../x.txt"],
		["an absolute target", "git restore /etc/hosts"],
		["a dotfile target", "git restore .env"],
		["a key file target", "git restore server.key"],
		["a security source target", "git restore packages/permissions/policy.ts"],
		["a directory target", "git restore config"],
		["a glob", "git restore config/*.json"],
		["pathspec magic", "git restore :/config/rates.json"],
		["chaining with &&", "git restore config/rates.json && rm -rf config"],
		["chaining with ;", "git restore config/rates.json; id"],
		["a pipe", `git show ${sha}:config/rates.json | tee config/rates.json`],
		["a pipe after the redirect", `git show ${sha}:config/rates.json > config/rates.json | cat`],
		["a command substitution", "git restore $(echo config/rates.json)"],
		["a backtick", "git restore `echo config/rates.json`"],
		["a subshell", "(git restore config/rates.json)"],
		["a second redirect", `git show ${sha}:config/rates.json > config/rates.json 2> /tmp/e`],
		["a heredoc", "git restore config/rates.json <<EOF"],
		[
			"an option in the rev slot of show",
			"git show --output=config/rates.json:config/rates.json > config/rates.json",
		],
		["an option as the rev of checkout", "git checkout -f -- config/rates.json"],
		["an option as the source", "git restore --source=--output=x config/rates.json"],
		["a spaced --source", `git restore --source ${sha} config/rates.json`],
		["--output= on show", `git show --output=config/rates.json ${sha}:config/rates.json`],
		["--staged", "git restore --staged config/rates.json"],
		["--patch", "git restore -p config/rates.json"],
		["a second separator", "git checkout -- -- config/rates.json"],
		["an option after the separator", "git restore -- --staged config/rates.json"],
		["a range as the rev", `git show ${sha}..HEAD:config/rates.json > config/rates.json`],
		["a caret rev", `git show ${sha}^:config/rates.json > config/rates.json`],
		["an unknown rev", "git show deadbeef:config/rates.json > config/rates.json"],
		["a rev that is not a commit-ish name", "git checkout nope -- config/rates.json"],
		["checkout without a separator", "git checkout config/rates.json"],
		["checkout of a branch", "git checkout main"],
		["no paths", "git restore"],
		["git reset", "git reset --hard HEAD"],
		["git show without a redirect", `git show ${sha}:config/rates.json`],
		["git clean", "git clean -fd"],
	];
	test("every unsafe or unlisted shape", () => {
		for (const [name, cmd] of refused())
			expect([name, cmd, restoreInProject(cmd, ws).ok]).toEqual([name, cmd, false]);
	});

	test("a target with uncommitted edits", () => {
		writeFileSync(join(ws, "config", "rates.json"), "edited");
		for (const cmd of [
			`git show ${sha}:config/rates.json > config/rates.json`,
			"git restore config/rates.json",
			"git checkout -- config/rates.json",
		])
			expect([cmd, restoreInProject(cmd, ws).ok]).toEqual([cmd, false]);
	});
	test("a target with a staged edit", () => {
		writeFileSync(join(ws, "config", "rates.json"), "edited");
		git(ws, "add", "config/rates.json");
		expect(restoreInProject("git restore config/rates.json", ws).ok).toBe(false);
	});

	test("no working directory", () => {
		expect(restoreInProject("git restore config/rates.json", undefined).ok).toBe(false);
	});
	test("a relative working directory", () => {
		expect(restoreInProject("git restore config/rates.json", "config").ok).toBe(false);
	});
	test("a directory that is not a git work tree", () => {
		expect(restoreInProject("git restore config/rates.json", outside).ok).toBe(false);
	});
	test("a subdirectory of the work tree", () => {
		expect(restoreInProject("git restore rates.json", join(ws, "config")).ok).toBe(false);
	});
});

describe("systemOneGate end to end with a judge that says dangerous", () => {
	test("the pilot restore runs without asking the judge", async () => {
		const r = await systemOneGate(
			`git show ${sha}:config/rates.json > config/rates.json`,
			process.env,
			ws,
		);
		expect(r.run).toBe(true);
		expect(r.guard?.backend).toBe("allowlist");
		expect(judge.asks).toBe(0);
	});

	for (const cmd of [
		"git show HEAD:config/rates.json > /etc/x",
		"git restore untracked.txt",
		"git restore config/rates.json && id",
		"git restore .env",
		"git restore --staged config/rates.json",
	]) {
		test(`still gated: ${cmd}`, async () => {
			const r = await systemOneGate(cmd, process.env, ws);
			expect(r.run).toBe(false);
			expect(r.message ?? "").toContain(SYSTEM_ONE_BLOCK_MARKER);
		});
	}

	test("EIGHT_S1_ALLOWLIST=0 turns the lane off with the rest of the allowlist", async () => {
		process.env[SYSTEM_ONE_ALLOWLIST_FLAG] = "0";
		const r = await systemOneGate("git restore config/rates.json", process.env, ws);
		expect(r.run).toBe(false);
	});
});
