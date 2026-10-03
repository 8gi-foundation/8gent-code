import { describe, expect, test } from "bun:test";
import {
	MAX_REVIEW_LINES,
	type TurnReviewToolCall,
	promptPaths,
	reviewTurn,
	turnReviewEnabled,
} from "../turn-review";

const CWD = "/work/repo";
const write = (path: string, content = "x", success = true): TurnReviewToolCall => ({
	name: "write_file",
	args: { path, content },
	success,
	result: success ? `File written: ${CWD}/${path}` : "Error: denied",
});
const edit = (path: string, newText = "y"): TurnReviewToolCall => ({
	name: "edit_file",
	args: { path, oldText: "a", newText },
	success: true,
	result: `File edited: ${CWD}/${path}`,
});
const run = (command: string, result: string, success = true): TurnReviewToolCall => ({
	name: "run_command",
	args: { command },
	success,
	result,
});
const read = (path: string): TurnReviewToolCall => ({
	name: "read_file",
	args: { path },
	success: true,
	result: "1\tx",
});

const review = (prompt: string, toolCalls: TurnReviewToolCall[], reply = "Done.") =>
	reviewTurn({ prompt, toolCalls, reply, workingDirectory: CWD });

describe("turnReviewEnabled", () => {
	test("only the exact string 1 turns it on", () => {
		expect(turnReviewEnabled({ EIGHT_TURN_REVIEW: "1" })).toBe(true);
		for (const v of [undefined, "", "0", "true", "yes", " 1", "1 "]) {
			expect(turnReviewEnabled({ EIGHT_TURN_REVIEW: v })).toBe(false);
		}
	});
});

describe("reviewTurn stays silent on a clean turn", () => {
	test("no tool calls", () => {
		expect(review("What does src/a.ts do?", [], "It parses config.")).toEqual([]);
	});

	test("read-only turn", () => {
		expect(review("Explain src/a.ts", [read("src/a.ts")], "It parses config.")).toEqual([]);
	});

	test("edits the named file, then tests pass", () => {
		const calls = [read("src/a.ts"), edit("src/a.ts"), run("bun test", " 4 pass\n 0 fail")];
		expect(review("Fix the bug in src/a.ts", calls)).toEqual([]);
	});

	test("a test file for the named source counts as asked for", () => {
		const calls = [edit("src/a.ts"), write("src/a.test.ts"), run("bun test", " 5 pass")];
		expect(review("Fix src/a.ts and add a test", calls)).toEqual([]);
	});

	test("a docs edit after the last test run is not a test gap", () => {
		const calls = [edit("src/a.ts"), run("bun test", " 4 pass"), edit("README.md")];
		expect(review("Fix src/a.ts and update README.md", calls)).toEqual([]);
	});

	test("a failure recovered by a later success of the same tool is not reported", () => {
		const calls = [
			{
				name: "edit_file",
				args: { path: "src/a.ts" },
				success: false,
				result: "Error: Could not find the text",
			},
			edit("src/a.ts"),
			run("bun test", " 1 pass"),
		];
		expect(review("Fix src/a.ts", calls)).toEqual([]);
	});

	test("a prompt that names no path gives no unasked-file line", () => {
		const calls = [edit("src/a.ts"), edit("src/b.ts"), run("bun test", " 2 pass")];
		expect(review("Add a done command to the todo CLI", calls)).toEqual([]);
	});

	test("a branch name in the prompt is not a file scope", () => {
		expect(promptPaths("commit on a new branch called feat/todo-done")).toEqual([]);
		expect(promptPaths("bump to 1.2.3 then edit src/a.ts")).toEqual(["src/a.ts"]);
		expect(promptPaths("push feat/x when done")).toEqual([]);
	});

	test("extensionless paths and directories the prompt names are scope", () => {
		// From pilot ops-cron-backup: ops/crontab was named and must not be flagged.
		const prompt =
			"The nightly backup in ops/crontab hasn't written anything to backups/. Sort out the cron entry and config/backup.env.";
		expect(promptPaths(prompt)).toEqual(["ops/crontab", "backups/", "config/backup.env"]);
		expect(promptPaths("update docs/guide.md and docs/")).toEqual(["docs/guide.md", "docs/"]);
	});

	test("config and data edits do not call for a test run", () => {
		// From pilot ops-package-script: adding a package.json script needs no test run.
		const calls = [
			edit("package.json"),
			run("bun run todos", "12 TODOs"),
			write("ops/crontab"),
			write("config/backup.env"),
		];
		expect(
			review("Add a script to package.json, fix ops/crontab and config/backup.env", calls),
		).toEqual([]);
	});
});

describe("reviewTurn flags what the reply left unsaid", () => {
	test("files changed that the prompt never named", () => {
		const calls = [edit("src/a.ts"), edit("src/other.ts"), run("bun test", " 3 pass")];
		const lines = review("Fix the bug in src/a.ts", calls);
		expect(lines).toEqual(["Unasked: changed src/other.ts; the prompt named src/a.ts."]);
	});

	test("code edited with no test run at all", () => {
		const lines = review("Fix src/a.ts", [edit("src/a.ts")]);
		expect(lines).toEqual(["Tests: no test command ran after editing src/a.ts."]);
	});

	test("code edited after the last test run", () => {
		const calls = [edit("src/a.ts"), run("bun test", " 1 pass"), edit("src/a.ts")];
		expect(review("Fix src/a.ts", calls)).toEqual([
			"Tests: src/a.ts changed after the last test run.",
		]);
	});

	test("last test run failed", () => {
		const calls = [edit("src/a.ts"), run("bun test", "Exit code 1:\n 1 fail")];
		expect(review("Fix src/a.ts", calls, "Fixed it.")).toEqual([
			"Tests: the last test run failed (exit 1).",
		]);
	});

	test("a blocked test command is not a test run", () => {
		const calls = [
			edit("src/a.ts"),
			run("bun test", "Exit code 1:\n 4 fail"),
			run("cd /work/repo && bun test", "[BLOCKED] Command chaining with && is not allowed.", false),
		];
		expect(review("Fix src/a.ts", calls, "Added it.")).toEqual([
			"Tests: the last test run failed (exit 1).",
		]);
	});

	test("skipped tests reported by the runner and skips added by the turn", () => {
		const calls = [
			edit("src/a.test.ts", 'test.skip("flaky for now", () => {})'),
			run("bun test", " 3 pass\n 1 skip\n 0 fail"),
		];
		const lines = review("Fix src/a.ts", calls);
		expect(lines).toEqual([
			"Tests: a skipped test was added in src/a.test.ts; the last test run reported 1 skipped.",
		]);
	});

	test("unresolved tool error the reply does not mention", () => {
		const calls = [
			edit("src/a.ts"),
			run("bun test", " 1 pass"),
			{ name: "git_commit", success: false, result: "Error: nothing added to commit" },
		];
		const lines = review("Fix src/a.ts and commit", calls, "All set.");
		expect(lines).toEqual([
			'Not in the reply: git_commit failed ("Error: nothing added to commit").',
		]);
	});

	test("warning in tool output the reply does not mention", () => {
		const calls = [
			edit("src/a.ts"),
			run("bun test", " 1 pass"),
			run("bun run build", "warning: unused import in src/a.ts\nbuilt"),
		];
		expect(review("Fix src/a.ts", calls, "Shipped.")).toEqual([
			'Not in the reply: run_command warned ("warning: unused import in src/a.ts").',
		]);
	});

	test("a reply that already admits the error is not flagged", () => {
		const calls = [
			edit("src/a.ts"),
			run("bun test", " 1 pass"),
			{ name: "git_push", success: false, result: "Error: no upstream" },
		];
		expect(review("Fix src/a.ts", calls, "Fixed, but the push failed: no upstream.")).toEqual([]);
	});

	test("never more than three lines, in a fixed order", () => {
		const calls = [
			edit("src/a.ts"),
			edit("src/b.ts"),
			{ name: "git_commit", success: false, result: "Error: x" },
		];
		const lines = review("Fix src/a.ts", calls, "Done.");
		expect(lines.length).toBeLessThanOrEqual(MAX_REVIEW_LINES);
		expect(lines.map((l) => l.split(":")[0])).toEqual(["Unasked", "Tests", "Not in the reply"]);
	});

	test("absolute paths from the tool log are shown relative to the working directory", () => {
		const lines = review("Fix src/a.ts", [edit(`${CWD}/src/z.ts`), run("bun test", " 1 pass")]);
		expect(lines).toEqual(["Unasked: changed src/z.ts; the prompt named src/a.ts."]);
	});
});

describe("reviewTurn scrubs secrets", () => {
	const ghp = `ghp_${"A1b2C3d4E5".repeat(3)}abcdef`; // 36 chars after the prefix

	test("a secret in an error message is redacted, never truncated into view", () => {
		const calls = [
			{ name: "git_push", success: false, result: `Error: auth failed for ${ghp} at remote` },
		];
		const lines = review("push it", calls, "Pushed.");
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("ghp_");
		expect(lines[0]).toContain("[REDACTED:github_token]");
	});

	test("a secret in a file name is redacted", () => {
		const lines = review("Fix src/a.ts", [edit(`notes-${ghp}.ts`), run("bun test", " 1 pass")]);
		expect(lines.join("\n")).not.toContain(ghp);
	});
});

describe("reviewTurn never throws", () => {
	test("malformed tool calls are tolerated", () => {
		const calls = [
			{ name: "edit_file", success: true },
			{ name: "run_command", args: { command: 42 }, success: true },
			{ name: "write_file", args: { path: "" }, success: true },
		] as unknown as TurnReviewToolCall[];
		expect(() => review("Fix src/a.ts", calls)).not.toThrow();
	});
});
