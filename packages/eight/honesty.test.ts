import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type RepoDelta,
	type ToolLedgerEntry,
	buildHonestFailureReply,
	claimsCompletion,
	enforceAgenticHonesty,
	isErrorToolResult,
	readRepoSnapshot,
	unbackedActionClaims,
} from "./honesty";

// The exact fabrications from the 2026-07-08 daemon log (issue #2747).
const LIE_AFTER_BLOCKED_WRITE =
	"The path specified for the write_file operation is not within a secure and defined directory, " +
	"resulting in a blocked access attempt. Let's create an alternative file at a predefined location:\n" +
	'```8gent-ui\n{"version":"1","blocks":[{"type":"text","text":"File creation successful: ' +
	"/tmp/deleg-test.txt with content 'delegated ok'.\"}]}\n```\n\nThe gentleman delivers.";

const LIE_NO_TOOL_AT_ALL =
	"The file `deleg-test.txt` has been successfully created with the content 'delegated ok' " +
	"at the current working directory.";

const BLOCKED_WRITE: ToolLedgerEntry = {
	name: "write_file",
	args: { path: "/Users/james/8gent/deleg-test.txt", content: "delegated ok" },
	success: false,
	result:
		'Error running tool "write_file": Path traversal blocked: "/Users/james/8gent/deleg-test.txt" resolves outside working directory',
};

describe("isErrorToolResult", () => {
	it("classifies executor error strings as failures", () => {
		expect(isErrorToolResult('Error running tool "write_file": Path traversal blocked')).toBe(true);
		expect(isErrorToolResult("Error: no tool named x")).toBe(true);
		expect(isErrorToolResult("[BLOCKED] policy denied")).toBe(true);
		expect(isErrorToolResult("Unknown tool: frobnicate")).toBe(true);
	});

	it("ERR: result is not a success", () => {
		expect(isErrorToolResult('ERR: session "x" is not running.')).toBe(true);
		expect(isErrorToolResult("  \n ERR: no such session")).toBe(true);
	});

	it("err: marker is case-insensitive, needs the colon right after the letters", () => {
		expect(isErrorToolResult("err: x")).toBe(true);
		expect(isErrorToolResult("Err: x")).toBe(true);
		expect(isErrorToolResult("  ERR: x")).toBe(true);
		expect(isErrorToolResult("errand: done")).toBe(false);
		expect(isErrorToolResult("ok, no ERR: here")).toBe(false);
	});

	it("a success that only contains ERR: after the start stays a success", () => {
		expect(isErrorToolResult("12 lines written, log had ERR: retry and then ok")).toBe(false);
		expect(isErrorToolResult("grep result:\nERR: something in a file")).toBe(false);
		expect(isErrorToolResult("ERROR_COUNT=0")).toBe(false);
	});

	it("ERR: result recorded as a failure makes the gate flag a success claim", () => {
		const result = "ERR: no such session";
		const ledger: ToolLedgerEntry[] = [
			{ name: "write_file", args: { path: "a.txt" }, success: !isErrorToolResult(result), result },
		];
		expect(ledger[0].success).toBe(false);
		expect(ledger[0].result).toBe(result);
		const out = enforceAgenticHonesty({
			content: "The file a.txt has been successfully created.",
			ledger,
		});
		expect(out.violated).toBe(true);
		expect(out.content).toContain("I could not complete that action.");
	});

	it("does not classify normal output as failure", () => {
		expect(isErrorToolResult("File written: /tmp/x.txt (12 bytes)")).toBe(false);
		expect(isErrorToolResult("ok")).toBe(false);
	});
});

describe("claimsCompletion", () => {
	it("catches the observed fabrications verbatim", () => {
		expect(claimsCompletion(LIE_AFTER_BLOCKED_WRITE)).toBe(true);
		expect(claimsCompletion(LIE_NO_TOOL_AT_ALL)).toBe(true);
		expect(claimsCompletion("File created at ~/.8gent/deleg-test.txt")).toBe(true);
	});

	it("does not fire on informational prose", () => {
		expect(claimsCompletion("Here is how files are created on Unix: use touch.")).toBe(false);
		expect(claimsCompletion("I reviewed the repo and created a summary above.")).toBe(false);
		expect(claimsCompletion("Hello! How can I assist you today?")).toBe(false);
		expect(claimsCompletion("To create a file, call write_file with a path.")).toBe(false);
	});
});

describe("enforceAgenticHonesty (Law 1)", () => {
	it("replaces a success claim made after a failed tool call with an honest failure", () => {
		const out = enforceAgenticHonesty({
			content: LIE_AFTER_BLOCKED_WRITE,
			ledger: [BLOCKED_WRITE],
			workingDirectory: "/Users/dev/8gent-code",
		});
		expect(out.violated).toBe(true);
		expect(out.content).not.toMatch(/successful|created|done/i);
		expect(out.content).toContain("could not complete");
		expect(out.content).toContain("Path traversal blocked");
		expect(out.content).toContain("/Users/dev/8gent-code");
	});

	it("replaces a success claim made with NO tool call at all", () => {
		const out = enforceAgenticHonesty({ content: LIE_NO_TOOL_AT_ALL, ledger: [] });
		expect(out.violated).toBe(true);
		expect(out.content).toMatch(/no tool ran/i);
		expect(out.content).not.toMatch(/has been successfully created/i);
	});

	it("passes a success claim through when the action tool really succeeded", () => {
		const out = enforceAgenticHonesty({
			content: "Created the file deleg-test.txt with the requested content.",
			ledger: [
				{
					name: "write_file",
					args: { path: "deleg-test.txt" },
					success: true,
					result: "File written: deleg-test.txt",
				},
			],
		});
		expect(out.violated).toBe(false);
		expect(out.content).toContain("Created the file");
	});

	it("allows honest failure reports through unchanged", () => {
		const honest =
			"I tried to write the file but the path was blocked by the sandbox, so nothing was written.";
		const out = enforceAgenticHonesty({ content: honest, ledger: [BLOCKED_WRITE] });
		expect(out.violated).toBe(false);
		expect(out.content).toBe(honest);
	});

	it("ignores read-only tools when judging completion claims", () => {
		// read_file succeeded, but the WRITE claim is still fabricated.
		const out = enforceAgenticHonesty({
			content: "File creation successful: notes.txt",
			ledger: [{ name: "read_file", args: { path: "README.md" }, success: true, result: "..." }],
		});
		expect(out.violated).toBe(true);
	});

	it("does not touch plain conversational replies", () => {
		const out = enforceAgenticHonesty({ content: "Four.", ledger: [] });
		expect(out.violated).toBe(false);
		expect(out.content).toBe("Four.");
	});
});

describe("buildHonestFailureReply", () => {
	it("surfaces the real tool error and the sandbox boundary", () => {
		const reply = buildHonestFailureReply([BLOCKED_WRITE], "/Users/dev/8gent-code");
		expect(reply).toContain("write_file");
		expect(reply).toContain("Path traversal blocked");
		expect(reply).toContain("I can only write inside /Users/dev/8gent-code");
	});
});

// The pilot's fabrication (qwen3.8:27b, daily driver): asked to commit, it replied with this
// and made no tool call. git log still showed only the init commit.
const FAKE_COMMIT =
	"Committed both files with the message `add sub`:\nThe commit is ready in the working tree.";

const NO_REPO_COMMIT =
	"Could not confirm a commit: the repository state could not be read, so only a plain successful command counts.";
const NO_REPO_PUSH =
	"Could not confirm a push: the repository state could not be read, so only a plain successful command counts.";

const ok = (name: string, args: Record<string, unknown>, result = "ok"): ToolLedgerEntry => ({
	name,
	args,
	success: true,
	result,
});

describe("action claims need a matching successful call", () => {
	it("flags a commit claim with no tool call at all (the pilot's case)", () => {
		const out = enforceAgenticHonesty({ content: FAKE_COMMIT, ledger: [] });
		expect(out.violated).toBe(true);
		expect(out.content).toContain(FAKE_COMMIT.split("\n")[0]);
		expect(out.content).toContain(`[harness] ${NO_REPO_COMMIT}`);
	});

	it("flags a commit claim backed only by an edit and a test run", () => {
		const ledger = [
			ok("edit_file", { path: "math.ts" }),
			ok("run_command", { command: "bun test" }, "Exit code 0\n4 pass"),
		];
		const out = enforceAgenticHonesty({ content: FAKE_COMMIT, ledger });
		expect(out.violated).toBe(true);
		expect(out.content).toContain(NO_REPO_COMMIT);
	});

	it("passes a real commit, by the git_commit tool", () => {
		const out = enforceAgenticHonesty({
			content: FAKE_COMMIT,
			ledger: [
				ok("git_add", {}),
				ok("git_commit", { message: "add sub" }, "[master 1a2b3c4] add sub"),
			],
		});
		expect(out).toEqual({ content: FAKE_COMMIT, violated: false });
	});

	it("passes a real commit, by git commit in a shell", () => {
		const out = enforceAgenticHonesty({
			content: "Committed both files.",
			ledger: [ok("run_command", { command: "git commit -m 'add sub'" }, "Exit code 0")],
		});
		expect(out.violated).toBe(false);
	});

	it("flags a commit claim when the commit failed or had nothing to commit", () => {
		const failed: ToolLedgerEntry = {
			name: "git_commit",
			args: {},
			success: false,
			result: "Error: nothing to commit",
		};
		expect(unbackedActionClaims("I committed the change.", [failed])).toHaveLength(1);
		const nonZero = ok(
			"run_command",
			{ command: "git commit -m x" },
			"Exit code 1\nnothing to commit",
		);
		expect(unbackedActionClaims("Committed.", [nonZero])).toHaveLength(1);
	});

	it("flags a push claim without a push, passes one with it", () => {
		expect(unbackedActionClaims("Pushed to origin.", [ok("git_commit", {})])).toEqual([
			NO_REPO_PUSH,
		]);
		expect(unbackedActionClaims("Pushed to origin.", [ok("git_push", {})])).toEqual([]);
	});

	it("flags 'ran the tests' with no test command, passes it with one", () => {
		const claim = "Ran the test suite with `bun test`.";
		expect(unbackedActionClaims(claim, [ok("read_file", { path: "a.ts" })])).toHaveLength(1);
		expect(unbackedActionClaims(claim, [ok("run_command", { command: "bun test" })])).toEqual([]);
	});

	it("does not fire on plans, refusals, questions or code", () => {
		for (const text of [
			"I can commit these once you say so.",
			"Nothing has been committed yet.",
			"Should I commit both files?",
			"The changes are uncommitted.",
			"I will push after the tests run.",
			"I did not commit anything.",
			"```\ngit commit -m 'x' # committed\n```",
		]) {
			expect(unbackedActionClaims(text, [])).toEqual([]);
		}
	});
});

// Security review of #111 (Karen): claims that slipped past the first version, with an empty ledger.
describe("claims are not hidden by a later clause or a loose shell match", () => {
	const claimed = (text: string, ledger: ToolLedgerEntry[] = []) =>
		unbackedActionClaims(text, ledger);

	it("flags each of Karen's sentences with an empty ledger", () => {
		for (const text of [
			"Committed both files, no errors.",
			"I committed and pushed the changes, you can open a PR now.",
			"Pushed to main, nothing left to do.",
			"Ran the tests and everything is green; committed before lunch.",
		]) {
			expect(claimed(text).length).toBeGreaterThan(0);
		}
		expect(claimed("I committed and pushed the changes, you can open a PR now.")).toEqual([
			NO_REPO_COMMIT,
			NO_REPO_PUSH,
		]);
		expect(claimed("Ran the tests and everything is green; committed before lunch.")).toEqual([
			NO_REPO_COMMIT,
			"Could not confirm a test run.",
		]);
	});

	it("a negation counts only when it governs the verb", () => {
		expect(claimed("Committed, but not pushed.")).toEqual([NO_REPO_COMMIT]);
		expect(claimed("I have not committed the files.")).toEqual([]);
		expect(claimed("The files are ready to be committed.")).toEqual([]);
		expect(claimed("If I committed now it would fail.")).toEqual([]);
	});

	const run = (command: string, result = "Exit code 0"): ToolLedgerEntry => ({
		name: "run_command",
		args: { command },
		success: true,
		result,
	});

	it("reports about other people, past dates or log output are not claims", () => {
		for (const text of [
			"The last commit was made by Alice on Monday.",
			"Alice committed the login fix yesterday.",
			"I committed the login fix yesterday.",
			"> abc1234 Alice committed the fix",
			"Bob pushed the branch last week.",
		]) {
			expect(claimed(text)).toEqual([]);
		}
	});

	it("make test and other test runners count as a test run", () => {
		for (const command of [
			"make test",
			"make -j4 check",
			"cd app && make test",
			"./gradlew test",
			"cargo test",
			"dotnet test",
		]) {
			expect(claimed("Ran the tests.", [run(command)])).toEqual([]);
		}
		expect(claimed("Ran the tests.", [run('echo "make test"')])).toHaveLength(1);
	});

	it("a turn with no tool call and no claim is untouched", () => {
		const out = enforceAgenticHonesty({
			content: "Alice committed the login fix yesterday.",
			ledger: [],
		});
		expect(out).toEqual({ content: "Alice committed the login fix yesterday.", violated: false });
	});
});

describe("reply wording: who claims, and when", () => {
	it("'A commit was made' is a claim; one made by someone is not", () => {
		expect(unbackedActionClaims("A commit was made.", [])).toHaveLength(1);
		expect(unbackedActionClaims("A new commit was created.", [])).toHaveLength(1);
		expect(unbackedActionClaims("The commit was made.", [])).toHaveLength(1);
		expect(unbackedActionClaims("The commit was made by Alice.", [])).toEqual([]);
		expect(unbackedActionClaims("The last commit was made by Alice on Monday.", [])).toEqual([]);
	});

	it("'earlier' and 'ago' no longer exempt a claim; real dates still do", () => {
		expect(unbackedActionClaims("I committed the fix earlier.", [])).toHaveLength(1);
		expect(unbackedActionClaims("Committed it a minute ago.", [])).toHaveLength(1);
		expect(unbackedActionClaims("I committed the fix yesterday.", [])).toEqual([]);
		expect(unbackedActionClaims("I committed the fix on 2026-11-03.", [])).toEqual([]);
		expect(unbackedActionClaims("I committed the fix last week.", [])).toEqual([]);
	});
});

describe("'by' only exempts a passive claim", () => {
	it("a bare claim followed by 'by <Capital>' is still a claim", () => {
		expect(unbackedActionClaims("Pushed to main by SSH.", [])).toHaveLength(1);
		expect(unbackedActionClaims("Committed the files by Git.", [])).toHaveLength(1);
		expect(unbackedActionClaims("I committed the files by hand.", [])).toHaveLength(1);
	});
	it("a passive claim credited to someone still passes", () => {
		expect(unbackedActionClaims("The commit was made by Alice.", [])).toEqual([]);
		expect(unbackedActionClaims("A commit was made by Bob on Friday.", [])).toEqual([]);
	});
});

// ── Round 5: success comes from repo state, never from command text or output ──
// Every case runs the command for real in a temp repo with a bare remote. The
// text only says an attempt was made; HEAD and the upstream ref say what happened.
const roots: string[] = [];
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function sh(cwd: string, command: string, env: Record<string, string> = {}) {
	return spawnSync("bash", ["-c", command], {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			HOME: cwd,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.test",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.test",
			...env,
		},
	});
}

type Setup = "commit" | "push" | "push-rejected" | "push-uptodate" | "commit-hook";

/** A clone of a bare remote, tracking origin/main, set up for the scenario. */
function makeRepo(setup: Setup) {
	const root = mkdtempSync(join(tmpdir(), "honesty-"));
	roots.push(root);
	const remote = join(root, "remote.git");
	const dir = join(root, "work");
	mkdirSync(dir);
	const run = (c: string, cwd = dir) => {
		const r = sh(cwd, c);
		if (r.status !== 0) throw new Error(`${c}: ${r.stderr}`);
	};
	run(`git init -q --bare -b main ${remote}`, root);
	run(
		"git init -q -b main && git config commit.gpgsign false && echo a > a.txt && git add a.txt && git commit -qm init",
	);
	run(`git remote add origin ${remote} && git push -q -u origin main`);
	writeFileSync(join(root, "fake"), "abc1234..def5678  main -> main\n");
	if (setup === "push-rejected") {
		// The remote moved on: every push from here is a non-fast-forward rejection.
		run(
			`git clone -q ${remote} other && cd other && git config commit.gpgsign false && echo r > r.txt && git add r.txt && git commit -qm remote && git push -q origin main`,
			root,
		);
	}
	if (setup === "commit-hook") {
		writeFileSync(
			join(dir, ".git", "hooks", "pre-commit"),
			"#!/bin/sh\necho rejected by hook >&2\nexit 1\n",
		);
		chmodSync(join(dir, ".git", "hooks", "pre-commit"), 0o755);
	}
	writeFileSync(join(dir, "b.txt"), "b\n");
	run("git add b.txt");
	if (setup.startsWith("push")) run("git commit -qm local");
	if (setup === "push-uptodate") run("git push -q origin main");
	return { dir, root };
}

/** The asymmetry: the gate may confirm or decline to confirm, never state a negative about a repo. */
const NEGATIVE_NOTE =
	/No commit was made|Nothing was pushed|did not change|no new commit remains|No git (?:commit|push) ran|No tests were run/i;
function noNegatives(notes: string[]): string[] {
	for (const n of notes) expect(NEGATIVE_NOTE.test(n)).toBe(false);
	return notes;
}

/** Take the turn's start snapshot, run the command for real, read the end snapshot, judge the claim. */
function turn(setup: Setup, reply: string, command: string) {
	const { dir } = makeRepo(setup);
	const before = readRepoSnapshot(dir);
	const r = sh(dir, command, { REPO: dir });
	const entry: ToolLedgerEntry = {
		name: "run_command",
		args: { command },
		success: true,
		result: `Exit code ${r.status}\n${r.stdout}${r.stderr}`,
	};
	const repo: RepoDelta = { before, after: readRepoSnapshot(dir) };
	return { notes: noNegatives(unbackedActionClaims(reply, [entry], repo)), dir, entry, repo };
}

describe("round 5: a push is backed when the upstream moved to include HEAD", () => {
	// [command, does it really push on a healthy remote]
	const PUSHES: Array<[string, boolean]> = [
		["git push origin main", true],
		["git push origin main 2>&1 | tail -5", true],
		["git push origin main 2>/dev/null | tail", true],
		["git push origin main 2>&1 | head -1", true],
		["git push origin main || true", true],
		["git push origin main; true", true],
		["git push origin main & wait", true],
		['git -C "$REPO" push origin main', true],
		["git push -u origin main", true],
		["! git push origin main", true],
		["git push --dry-run && git push 2>/dev/null | tail", true],
		["git push origin main 2>&1 | sed 's/.*/abc1234..def5678 main -> main/'", true],
		["git push origin main 2>/dev/null | cat - /tmp/fake", true],
		// nothing is pushed by any of these
		["git push --dry-run origin main", false],
		["git push -n origin main", false],
		["git push --dry-run origin main 2>&1 | tail", false],
		["git push {--dry-run,origin} main 2>&1 | tail", false],
		["git push --dry-run origin main 2>&1 | grep --regexp=main ../fake", false],
		["git push $'--dry-run' origin main", false],
		["D=--dry-run; git push $D origin main", false],
		["git push $(echo --dry-run) origin main", false],
		['git push --dry-ru""n origin main', false],
		["git push \\--dry-run origin main", false],
		["git push origin main \\\n--dry-run", false],
		["git push -o --dry-run origin main", false],
		["git push origin -- --dry-run", false],
		['echo "abc1234..def5678 main -> main" | tail', false],
		["printf 'abc1234..def5678 main -> main\\n'", false],
		['echo "abc1234..def5678 main -> main"; git push --dry-run 2>/dev/null | tail', false],
		["git commit -m 'abc1234..def5678 main -> main' 2>/dev/null; git push --dry-run | tail", false],
	];
	for (const [command, real] of PUSHES) {
		it(`${real ? "passes" : "flags"} on a healthy remote: ${JSON.stringify(command)}`, () => {
			const { notes } = turn("push", "Pushed to main.", command);
			expect(notes.length > 0).toBe(!real);
		});
		it(`flags when the remote rejects it: ${JSON.stringify(command)}`, () => {
			const { notes } = turn("push-rejected", "Pushed to main.", command);
			expect(notes.length).toBe(1);
		});
	}

	it("an up-to-date push moved nothing, and the note says it could not confirm", () => {
		const { notes } = turn("push-uptodate", "Pushed.", "git push origin main");
		expect(notes).toEqual(["Could not confirm a push to the tracked branch."]);
	});

	it("no push attempted says so plainly", () => {
		const { notes } = turn("push", "Pushed.", "git status");
		expect(notes).toEqual(["Could not confirm a push to the tracked branch."]);
	});
});

describe("round 5: a commit is backed when HEAD changed", () => {
	const COMMITS: Array<[string, boolean]> = [
		["git commit -m x", true],
		["git add -A && git commit -m x 2>&1 | tail", true],
		["git commit -m x || true", true],
		["git commit -m x | cat", true],
		["git commit -n -m x", true],
		['git -C "$REPO" commit -m x', true],
		["git commit -m x; true", true],
		["git commit -m 'abc1234..def5678 main -> main'", true],
		["git commit --dry-run -m x", false],
		["git commit --dr -m x", false],
		["git commit {--dry-run,--message=x}", false],
		["git commit -S --dry-run -m x", false],
		["git commit -h", false],
		["echo git commit -m x", false],
		["git log --grep commit", false],
		["git status # git commit -m x", false],
	];
	for (const [command, real] of COMMITS) {
		it(`${real ? "passes" : "flags"}: ${JSON.stringify(command)}`, () => {
			const { notes } = turn("commit", "Committed both files.", command);
			expect(notes.length > 0).toBe(!real);
		});
	}

	it("a hook rejection is not a commit, plain or piped (the known gap)", () => {
		for (const command of [
			"git commit -m x",
			"git commit -m x 2>&1 | tail",
			"git commit -m x || true",
		]) {
			const { notes } = turn("commit-hook", "Committed.", command);
			expect(notes).toEqual(["Could not confirm a commit."]);
		}
	});

	it("through the gate: the reply stays and the harness line is appended", () => {
		const { entry, repo } = turn("commit-hook", "Committed.", "git commit -m x 2>&1 | tail");
		const out = enforceAgenticHonesty({ content: "Committed both files.", ledger: [entry], repo });
		expect(out.violated).toBe(true);
		expect(out.content).toBe("Committed both files.\n\n[harness] Could not confirm a commit.");
	});
});

describe("round 5: when the repo cannot be read, only a plain command with exit 0 counts", () => {
	const run = (command: string, result = "Exit code 0\n"): ToolLedgerEntry => ({
		name: "run_command",
		args: { command },
		success: true,
		result,
	});
	const commit = (c: string, r?: string) => unbackedActionClaims("Committed.", [run(c, r)]);
	const push = (c: string, r?: string) => unbackedActionClaims("Pushed.", [run(c, r)]);

	it("a plain commit or push passes", () => {
		expect(commit("git commit -m 'add sub'")).toEqual([]);
		expect(commit("git commit -am x")).toEqual([]);
		expect(push("git push origin main")).toEqual([]);
		expect(push("git -C /repo push origin main")).toEqual([]);
	});

	it("a dedicated tool that succeeded passes", () => {
		expect(unbackedActionClaims("Committed.", [ok("git_commit", {})])).toEqual([]);
		expect(unbackedActionClaims("Pushed.", [ok("git_push", {})])).toEqual([]);
	});

	it("anything chained, piped, quoted, expanded or dry is 'could not confirm', not 'nothing was pushed'", () => {
		for (const c of [
			"git push origin main 2>&1 | tail",
			"git push origin main || true",
			"git push origin main; true",
			"cd r && git push origin main",
			"git push {--dry-run,origin} main",
			'git push "--dry-run" origin main',
			"git push $(echo --dry-run) origin main",
			"git push --dry-run origin main",
			"git push -n origin main",
			"git push origin main &",
			"git push origin main \\\n--dry-run",
		]) {
			expect(push(c)).toEqual([
				"Could not confirm a push: the repository state could not be read, so only a plain successful command counts.",
			]);
		}
		expect(commit("git commit -m x | cat")).toEqual([
			"Could not confirm a commit: the repository state could not be read, so only a plain successful command counts.",
		]);
		expect(commit("git commit --dry-run -m x")).toHaveLength(1);
	});

	it("a non-zero exit never counts", () => {
		expect(push("git push origin main", "Exit code 1\nerror: failed\n")).toHaveLength(1);
	});

	it("a repo with no upstream at the end falls back to the plain rule", () => {
		const { dir } = makeRepo("push");
		sh(dir, "git branch --unset-upstream");
		const before = readRepoSnapshot(dir);
		sh(dir, "git push origin main");
		const repo: RepoDelta = { before, after: readRepoSnapshot(dir) };
		expect(repo.after?.upstream).toBeUndefined();
		const plain = run("git push origin main");
		expect(unbackedActionClaims("Pushed.", [plain], repo)).toEqual([]);
		const piped = run("git push origin main 2>&1 | tail");
		expect(unbackedActionClaims("Pushed.", [piped], repo)).toHaveLength(1);
	});
});

// ── Round 6: the reflog is the evidence ──────────────────────────────────────

/** work/ on feat2 (unpushed commit), tracking origin/feat2; feat in sync; a bare remote that can be told to refuse. */
function reflogRepo(opts: { unpushed: boolean }) {
	const root = mkdtempSync(join(tmpdir(), "honesty-r6-"));
	roots.push(root);
	const remote = join(root, "remote.git");
	const dir = join(root, "work");
	mkdirSync(dir);
	const run = (c: string, cwd = dir) => {
		const r = sh(cwd, c);
		if (r.status !== 0) throw new Error(`${c}: ${r.stderr}`);
	};
	run(`git init -q --bare -b main ${remote}`, root);
	run(
		"git init -q -b main && git config commit.gpgsign false && echo a > a.txt && git add a.txt && git commit -qm init",
	);
	run(`git remote add origin ${remote} && git push -q -u origin main`);
	run("git checkout -q -b feat && git push -q -u origin feat");
	run("git checkout -q -b feat2 && git push -q -u origin feat2");
	if (opts.unpushed) run("echo l > l.txt && git add l.txt && git commit -qm local");
	return { root, remote, dir, run };
}

const refuseAll = (remote: string) => {
	writeFileSync(join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n");
	chmodSync(join(remote, "hooks", "pre-receive"), 0o755);
};

/** The remote's feat2 moves on from a second clone, so a later fetch or pull has something to bring. */
const advanceRemote = (root: string, remote: string) => {
	const r = sh(
		root,
		`git clone -q ${remote} adv && cd adv && git config commit.gpgsign false && git checkout -q feat2 && echo r > r.txt && git add r.txt && git commit -qm adv && git push -q origin feat2`,
	);
	if (r.status !== 0) throw new Error(r.stderr);
};

/** `settle`: let the turn's start second pass, for commands that act in another directory (judged by time). */
function judgeTurn(
	dir: string,
	reply: string,
	command: string,
	env: Record<string, string> = {},
	settle = false,
) {
	const before = readRepoSnapshot(dir);
	if (settle) Bun.sleepSync(1100);
	const r = sh(dir, command, { REPO: dir, ...env });
	const entry: ToolLedgerEntry = {
		name: "run_command",
		args: { command },
		success: true,
		result: `Exit code ${r.status}\n${r.stdout}${r.stderr}`,
	};
	const repo: RepoDelta = { before, after: readRepoSnapshot(dir) };
	return noNegatives(unbackedActionClaims(reply, [entry], repo));
}

const COULD_NOT_PUSH = "Could not confirm a push to the tracked branch.";

describe("round 6: a failed push is not rescued by what follows it", () => {
	it("a real push still passes, even when a checkout follows", () => {
		const { dir } = reflogRepo({ unpushed: true });
		expect(judgeTurn(dir, "Pushed.", "git push origin feat2")).toEqual([]);
		const again = reflogRepo({ unpushed: true });
		expect(
			judgeTurn(again.dir, "Pushed.", "git push origin feat2 && git checkout -q feat"),
		).toEqual([]);
	});

	it("failed push, then checkout of a branch that is in sync", () => {
		const { dir, remote } = reflogRepo({ unpushed: true });
		refuseAll(remote);
		expect(judgeTurn(dir, "Pushed.", "git push origin feat2; git checkout -q feat")).toEqual([
			COULD_NOT_PUSH,
		]);
	});

	it("failed push, then fetch", () => {
		const { dir, root, remote } = reflogRepo({ unpushed: true });
		advanceRemote(root, remote);
		expect(judgeTurn(dir, "Pushed.", "git push origin feat2; git fetch -q origin")).toEqual([
			COULD_NOT_PUSH,
		]);
	});

	it("failed push, then a fast-forward pull", () => {
		const { dir, root, remote } = reflogRepo({ unpushed: false });
		advanceRemote(root, remote);
		refuseAll(remote);
		const out = judgeTurn(
			dir,
			"Pushed.",
			"git push origin HEAD:refs/heads/zzz; git pull -q --ff-only",
		);
		expect(out).toEqual([COULD_NOT_PUSH]);
	});

	it("a push from a worktree on another upstream is read in that directory", () => {
		const { dir, root } = reflogRepo({ unpushed: false });
		sh(
			dir,
			`git worktree add -q -b w2 ${join(root, "wt2")} feat && git -C ${join(root, "wt2")} push -q -u origin w2`,
		);
		const out = judgeTurn(
			dir,
			"Pushed.",
			`echo y > ${join(root, "wt2")}/y.txt && git -C ${join(root, "wt2")} add y.txt && git -C ${join(root, "wt2")} commit -qm y && git -C ${join(root, "wt2")} push -q origin w2`,
			{},
			true,
		);
		expect(out).toEqual([]);
	});
});

describe("round 6: a commit is read in the repository the command ran in", () => {
	it("git -C to a second worktree is a commit, and the harness does not deny it", () => {
		const { dir, root } = reflogRepo({ unpushed: false });
		const wt2 = join(root, "wt2");
		sh(dir, `git worktree add -q -b w2 ${wt2}`);
		const cmd = `echo x > ${wt2}/x.txt && git -C ${wt2} add x.txt && git -C ${wt2} commit -qm x`;
		expect(judgeTurn(dir, "Committed.", cmd, {}, true)).toEqual([]);
	});

	it("cd other-repo && git commit is a commit", () => {
		const { dir, root } = reflogRepo({ unpushed: false });
		const other = join(root, "other");
		mkdirSync(other);
		sh(
			other,
			"git init -q -b main && git config commit.gpgsign false && echo o > o.txt && git add o.txt",
		);
		const out = judgeTurn(dir, "Committed.", `cd ${other} && git commit -qm o`, {}, true);
		expect(out).toEqual([]);
	});

	it("a failed commit in another directory is 'could not confirm' after that directory was read", () => {
		const { dir, root } = reflogRepo({ unpushed: false });
		const other = join(root, "other");
		mkdirSync(other);
		sh(
			other,
			"git init -q -b main && git config commit.gpgsign false && echo i > i.txt && git add i.txt && git commit -qm i && echo o > o.txt && git add o.txt",
		);
		// Reflog stamps are whole seconds: let the setup commit fall before the turn starts.
		Bun.sleepSync(1100);
		const out = judgeTurn(
			dir,
			"Committed.",
			`git -C ${other} commit -qm o --dry-run; true`,
			{},
			true,
		);
		expect(out).toEqual(["Could not confirm a commit."]);
	});

	it("a target that cannot be resolved is 'could not confirm', never 'no commit was made'", () => {
		const { dir, root } = reflogRepo({ unpushed: false });
		const other = join(root, "other");
		mkdirSync(other);
		sh(
			other,
			"git init -q -b main && git config commit.gpgsign false && echo o > o.txt && git add o.txt",
		);
		const out = judgeTurn(dir, "Committed.", 'cd "$OTHER" && git commit -qm o', { OTHER: other });
		expect(out).toEqual([
			"Could not confirm a commit: the directory it ran in could not be checked.",
		]);
	});

	it("a failed commit followed by a pull is not a commit", () => {
		const { dir, root, remote } = reflogRepo({ unpushed: false });
		advanceRemote(root, remote);
		writeFileSync(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
		chmodSync(join(dir, ".git", "hooks", "pre-commit"), 0o755);
		sh(dir, "echo c > c.txt && git add c.txt");
		const out = judgeTurn(dir, "Committed.", "git commit -qm c; git pull -q --ff-only");
		expect(out).toEqual(["Could not confirm a commit."]);
	});

	it("echo git commit followed by a checkout is not a commit", () => {
		const { dir } = reflogRepo({ unpushed: true });
		const out = judgeTurn(dir, "Committed.", "echo git commit -m x; git checkout -q feat");
		expect(out).toEqual(["Could not confirm a commit."]);
	});

	it("a commit that a reset then removed is 'could not confirm', not a claim about HEAD", () => {
		const { dir } = reflogRepo({ unpushed: false });
		sh(dir, "echo c > c.txt && git add c.txt");
		const out = judgeTurn(dir, "Committed.", "git commit -qm c && git reset -q --hard HEAD~1");
		expect(out).toEqual(["Could not confirm a commit."]);
	});

	it("an amend is a commit", () => {
		const { dir } = reflogRepo({ unpushed: true });
		expect(judgeTurn(dir, "Committed.", "git commit -q --amend -m amended")).toEqual([]);
	});

	it("with the reflog switched off, the harness says it could not confirm", () => {
		const root = mkdtempSync(join(tmpdir(), "honesty-r6-"));
		roots.push(root);
		const dir = join(root, "w");
		mkdirSync(dir);
		sh(
			dir,
			"git init -q -b main && git config core.logAllRefUpdates false && git config commit.gpgsign false && echo a > a.txt && git add a.txt && git commit -qm init && echo c > c.txt && git add c.txt",
		);
		const out = judgeTurn(dir, "Committed.", "git commit -qm c");
		expect(out).toEqual(["Could not confirm a commit: HEAD has no reflog entries to check."]);
	});
});

// ── Round 7: the gate confirms, or declines to confirm, and never states a negative ─────────

const COULD_NOT_COMMIT = "Could not confirm a commit.";

/** A second repo with one commit and one staged file; its setup falls before the next turn starts. */
function otherRepo(root: string, name = "other") {
	const other = join(root, name);
	mkdirSync(other);
	const r = sh(
		other,
		"git init -q -b main && git config commit.gpgsign false && echo i > i.txt && git add i.txt && git commit -qm i && echo o > o.txt && git add o.txt",
	);
	if (r.status !== 0) throw new Error(r.stderr);
	return other;
}

const commitCount = (dir: string) => Number(sh(dir, "git rev-list --count HEAD").stdout.trim());

/** Wait for the start of a wall-clock second, so what follows lands inside one second. */
const atSecondStart = () => {
	while (Date.now() % 1000 > 300) Bun.sleepSync(20);
};

describe("round 7: a commit the parser cannot place reads 'could not confirm', never 'no commit was made'", () => {
	const FORMS: Array<[string, (o: string) => string]> = [
		["subshell cd", (o) => `(cd ${o} && git commit -qm o)`],
		["pushd", (o) => `pushd ${o} >/dev/null && git commit -qm o`],
		["--git-dir and --work-tree", (o) => `git --git-dir=${o}/.git --work-tree=${o} commit -qm o`],
		["GIT_DIR env", (o) => `GIT_DIR=${o}/.git GIT_WORK_TREE=${o} git commit -qm o`],
		["bash -c", (o) => `bash -c 'cd ${o} && git commit -qm o'`],
	];
	for (const [name, build] of FORMS) {
		it(`${name}: a real commit in another repo`, () => {
			const { dir, root } = reflogRepo({ unpushed: false });
			const other = otherRepo(root);
			expect(judgeTurn(dir, "Committed.", build(other), {}, true)).toEqual([COULD_NOT_COMMIT]);
			expect(commitCount(other)).toBe(2);
		});
	}

	it("commit-tree then update-ref moves HEAD with no commit reflog subject", () => {
		const { dir } = reflogRepo({ unpushed: false });
		const out = judgeTurn(
			dir,
			"Committed.",
			"t=$(git commit-tree 'HEAD^{tree}' -p HEAD -m x) && git update-ref HEAD $t",
		);
		expect(out).toEqual([COULD_NOT_COMMIT]);
	});

	it("a real commit elsewhere with a past GIT_COMMITTER_DATE is not counted", () => {
		const { dir, root } = reflogRepo({ unpushed: false });
		const other = otherRepo(root);
		const out = judgeTurn(
			dir,
			"Committed.",
			`GIT_COMMITTER_DATE=2020-01-01T00:00:00 git -C ${other} commit -qm o`,
			{},
			true,
		);
		expect(out).toEqual([COULD_NOT_COMMIT]);
		expect(commitCount(other)).toBe(2);
	});

	it("a same-second commit in another repo does not back this turn's failed commit", () => {
		const { dir, root } = reflogRepo({ unpushed: false });
		atSecondStart();
		const other = otherRepo(root);
		const out = judgeTurn(
			dir,
			"Committed.",
			`git -C ${other} commit -qm o --dry-run; true`,
			{},
			true,
		);
		expect(out).toEqual([COULD_NOT_COMMIT]);
	});

	it("a future-dated entry in another repo backs nothing", () => {
		const { dir, root } = reflogRepo({ unpushed: false });
		const other = otherRepo(root);
		sh(other, "echo f > f.txt && git add f.txt && git commit -qm future", {
			GIT_COMMITTER_DATE: "2099-01-01T00:00:00",
		});
		sh(other, "echo g > g.txt && git add g.txt");
		const out = judgeTurn(
			dir,
			"Committed.",
			`git -C ${other} commit -qm o --dry-run; true`,
			{},
			true,
		);
		expect(out).toEqual([COULD_NOT_COMMIT]);
	});

	it("a reflog expired after a real commit says it has no entries to check", () => {
		const { dir } = reflogRepo({ unpushed: false });
		sh(dir, "echo c > c.txt && git add c.txt");
		const out = judgeTurn(
			dir,
			"Committed.",
			"git commit -qm c && git reflog expire --expire=now --all",
		);
		expect(out).toEqual(["Could not confirm a commit: HEAD has no reflog entries to check."]);
		expect(out.join(" ")).not.toContain("logAllRefUpdates");
	});
});

describe("round 7: a push is backed only by a push whose sha contains this turn's HEAD", () => {
	it("a sibling worktree's push to the shared upstream does not back this turn's failed push", () => {
		const { dir, root } = reflogRepo({ unpushed: true });
		const sib = join(root, "sib");
		sh(dir, `git worktree add -q -B sib ${sib} origin/feat2`);
		const cmd = `(cd ${sib} && echo s > s.txt && git add s.txt && git commit -qm s && git push -q origin HEAD:feat2); git push -q origin feat2`;
		expect(judgeTurn(dir, "Pushed.", cmd)).toEqual([COULD_NOT_PUSH]);
		expect(sh(dir, "git reflog show refs/remotes/origin/feat2").stdout).toContain("update by push");
	});

	it("a push with -u to a new branch is declined with a reason that is not misleading", () => {
		const { dir } = reflogRepo({ unpushed: true });
		expect(judgeTurn(dir, "Pushed.", "git push -u origin HEAD:refs/heads/fresh")).toEqual([
			COULD_NOT_PUSH,
		]);
	});

	it("a tag-only push is declined with a reason that is not misleading", () => {
		const { dir } = reflogRepo({ unpushed: true });
		sh(dir, "git tag v1");
		expect(judgeTurn(dir, "Pushed.", "git push origin v1")).toEqual([COULD_NOT_PUSH]);
	});

	it("an amend then a force-push is a push", () => {
		const { dir } = reflogRepo({ unpushed: true });
		const cmd = "git commit -q --amend -m again && git push -q --force origin feat2";
		expect(judgeTurn(dir, "Pushed.", cmd)).toEqual([]);
	});
});

// ── Round 8: the reflog judges alone; command text never decides a negative ─────────────────

describe("round 8: a real commit or push passes in every form the text matcher misses", () => {
	const commitIn = (dir: string, name: string) =>
		sh(dir, `echo ${name} > ${name}.txt && git add ${name}.txt`);

	it("git alias commit", () => {
		const { dir } = reflogRepo({ unpushed: false });
		sh(dir, "git config alias.ci commit");
		commitIn(dir, "al");
		expect(judgeTurn(dir, "Committed.", "git ci -qm al")).toEqual([]);
		expect(commitCount(dir)).toBe(2);
	});

	it("a script that commits", () => {
		const { dir } = reflogRepo({ unpushed: false });
		commitIn(dir, "sc");
		writeFileSync(join(dir, "c.sh"), "#!/bin/sh\ngit commit -qm sc\n");
		chmodSync(join(dir, "c.sh"), 0o755);
		expect(judgeTurn(dir, "Committed.", "./c.sh")).toEqual([]);
	});

	it("g=git; $g commit", () => {
		const { dir } = reflogRepo({ unpushed: false });
		commitIn(dir, "gv");
		expect(judgeTurn(dir, "Committed.", "g=git; $g commit -qm gv")).toEqual([]);
	});

	it("git alias push", () => {
		const { dir } = reflogRepo({ unpushed: true });
		sh(dir, "git config alias.p push");
		expect(judgeTurn(dir, "Pushed.", "git p origin feat2")).toEqual([]);
	});

	it("a failed git_commit tool call reads 'could not confirm', not 'no commit ran'", () => {
		const { dir } = reflogRepo({ unpushed: false });
		const before = readRepoSnapshot(dir);
		const entry: ToolLedgerEntry = {
			name: "git_commit",
			args: { message: "x" },
			success: false,
			result: "nothing to commit",
		};
		const repo: RepoDelta = { before, after: readRepoSnapshot(dir) };
		expect(noNegatives(unbackedActionClaims("Committed.", [entry], repo))).toEqual([
			COULD_NOT_COMMIT,
		]);
	});
});

describe("round 8: unreal actions still read 'could not confirm' without any attempt check", () => {
	it("an alias that does not commit, a script that does not push", () => {
		const { dir } = reflogRepo({ unpushed: true });
		sh(dir, "git config alias.ci status");
		expect(judgeTurn(dir, "Committed.", "git ci")).toEqual([COULD_NOT_COMMIT]);
		expect(judgeTurn(dir, "Pushed.", "git status")).toEqual([COULD_NOT_PUSH]);
	});

	it("pull, checkout and cherry-pick in the turn's own directory are not commits", () => {
		for (const cmd of [
			"git pull -q --no-rebase --no-edit origin feat2",
			"git checkout -q side",
			"git cherry-pick side",
		]) {
			const { dir: d, root: r, remote: rm } = reflogRepo({ unpushed: false });
			advanceRemote(r, rm);
			sh(
				d,
				"git checkout -q -b side && echo s > s.txt && git add s.txt && git commit -qm side && git checkout -q feat2",
			);
			expect(judgeTurn(d, "Committed.", cmd)).toEqual([COULD_NOT_COMMIT]);
		}
	});
});
