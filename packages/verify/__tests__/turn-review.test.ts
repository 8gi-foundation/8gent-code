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
		expect(lines).toEqual(["Not asked for: changed src/other.ts (prompt named src/a.ts)."]);
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

	test("unresolved tool error the reply does not mention names the tool, not its output", () => {
		const calls = [
			edit("src/a.ts"),
			run("bun test", " 1 pass"),
			{ name: "git_commit", success: false, result: "Error: nothing added to commit" },
		];
		const lines = review("Fix src/a.ts and commit", calls, "All set.");
		expect(lines).toEqual(["Not in the reply: git_commit failed."]);
	});

	test("a failed command is named by its command, never by quoting its output", () => {
		const calls = [
			edit("src/a.ts"),
			run("bun test", " 1 pass"),
			{ name: "git_push", args: { command: "x" }, success: true, result: "fine" },
			run("git push origin feat/x", "Exit code 1:\nremote rejected"),
		];
		const lines = review("Fix src/a.ts", calls, "Shipped.");
		expect(lines).toEqual(["Not in the reply: run_command `git push origin feat/x` failed."]);
		expect(lines.join("\n")).not.toContain("Exit code");
		expect(lines.join("\n")).not.toContain("remote rejected");
	});

	test("a long command is clipped when named", () => {
		const long = `node scripts/migrate.js --from ${"a".repeat(80)}`;
		const lines = review("migrate it", [run(long, "Exit code 2:\nboom")], "Migrated.");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("run_command `node scripts/migrate.js --from aaaaaa...` failed");
	});

	test("warning printed by a command the reply does not mention", () => {
		const calls = [
			edit("src/a.ts"),
			run("bun test", " 1 pass"),
			run("bun run build", "warning: unused import in src/a.ts\nbuilt"),
		];
		expect(review("Fix src/a.ts", calls, "Shipped.")).toEqual([
			"Not in the reply: run_command `bun run build` printed a warning.",
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
		expect(lines.map((l) => l.split(":")[0])).toEqual([
			"Not asked for",
			"Tests",
			"Not in the reply",
		]);
	});

	test("absolute paths from the tool log are shown relative to the working directory", () => {
		const lines = review("Fix src/a.ts", [edit(`${CWD}/src/z.ts`), run("bun test", " 1 pass")]);
		expect(lines).toEqual(["Not asked for: changed src/z.ts (prompt named src/a.ts)."]);
	});
});

describe("reviewer probes from the 8PO review (#3419)", () => {
	test("product names are not paths", () => {
		expect(promptPaths("Port the Next.js page to Vue.js, then check Node.js 22")).toEqual([]);
		// A product name must not switch on the scope check for every edit.
		const calls = [edit("src/page.tsx"), run("bun test", " 1 pass")];
		expect(review("Port the Next.js page", calls)).toEqual([]);
		// Real files still count, with or without a slash.
		expect(promptPaths("edit app.js and src/next.js")).toEqual(["app.js", "src/next.js"]);
	});

	test("a bare word needs a slash or a known file extension", () => {
		expect(promptPaths("e.g. bump v2.1 to 1.2.3, see foo.bar")).toEqual([]);
		expect(promptPaths("update notes.md and setup.py")).toEqual(["notes.md", "setup.py"]);
	});

	test("a test name with a number in it is not a skip count", () => {
		const out = " ✓ renders 3 todo items\n ✓ shows 2 skipped rows as grey\n 4 pass\n 0 fail";
		const calls = [edit("src/a.ts"), run("bun test", out)];
		expect(review("Fix src/a.ts", calls)).toEqual([]);
	});

	test("a summary line that is only a count still reports skips", () => {
		const calls = [edit("src/a.ts"), run("bun test", " 3 pass\n 2 todo\n 0 fail")];
		expect(review("Fix src/a.ts", calls)).toEqual(["Tests: the last test run reported 2 skipped."]);
	});

	test("warnings inside files read or searched are not reported", () => {
		const calls = [
			edit("src/a.ts"),
			{
				name: "read_file",
				args: { path: "src/log.ts" },
				success: true,
				result: '1\tconsole.warn("warning: x")',
			},
			{
				name: "search_symbols",
				args: { query: "warn" },
				success: true,
				result: "warning: matched",
			},
			run("bun test", " 1 pass"),
		];
		expect(review("Fix src/a.ts", calls, "Done.")).toEqual([]);
	});

	for (const probe of [
		"grep -n TODO src/a.ts",
		"rg done src",
		"git diff --quiet",
		"git diff --exit-code src/a.ts",
		"test -f out.json",
		"[ -f out.json ]",
		"FOO=1 grep x y",
	]) {
		test(`exit 1 from the probe \`${probe}\` is not a failure`, () => {
			const calls = [edit("src/a.ts"), run("bun test", " 1 pass"), run(probe, "Exit code 1:\n")];
			expect(review("Fix src/a.ts", calls, "Done.")).toEqual([]);
		});
	}

	test("a probe that exits 2 (a real error) is still reported", () => {
		const calls = [
			edit("src/a.ts"),
			run("bun test", " 1 pass"),
			run("grep -n x missing.ts", "Exit code 2:\nNo such file"),
		];
		expect(review("Fix src/a.ts", calls, "Done.")).toEqual([
			"Not in the reply: run_command `grep -n x missing.ts` failed.",
		]);
	});

	test("a non-probe command that exits 1 is still reported", () => {
		const calls = [
			edit("src/a.ts"),
			run("bun test", " 1 pass"),
			run("bun run lint", "Exit code 1:\n3 errors"),
		];
		expect(review("Fix src/a.ts", calls, "Done.")).toEqual([
			"Not in the reply: run_command `bun run lint` failed.",
		]);
	});
});

describe("reviewTurn stays linear on huge input (8SO review, #3419)", () => {
	// The first version's prompt regex took 1.9 s on 50k and 31-34 s on 200k
	// of these runs: synchronous, after the turn, so the daemon froze.
	const runs = [
		"a".repeat(200_000),
		"a.".repeat(100_000),
		"a-".repeat(100_000),
		"a/".repeat(100_000),
	];

	test("promptPaths on 200k-char runs with no whitespace finishes in under 50 ms", () => {
		for (const run200k of runs) {
			const t0 = performance.now();
			promptPaths(run200k);
			expect(performance.now() - t0).toBeLessThan(50);
		}
	});

	test("reviewTurn with a 200k-char prompt, command, path, output and reply finishes in under 50 ms", () => {
		for (const big of runs) {
			const calls = [
				edit("src/a.ts"),
				edit(big),
				run(big, `Exit code 1:\n${big}`),
				run("bun test", `${big}\n 1 skip`),
				{ name: "read_file", args: { path: big }, success: true, result: big },
			];
			const t0 = performance.now();
			const lines = review(big, calls, big);
			expect(performance.now() - t0).toBeLessThan(50);
			expect(lines.length).toBeLessThanOrEqual(MAX_REVIEW_LINES);
		}
	});
});

describe("reviewTurn scrubs secrets", () => {
	const ghp = `ghp_${"A1b2C3d4E5".repeat(3)}abcdef`; // 36 chars after the prefix

	test("a secret in tool output never reaches a line, because output is never quoted", () => {
		const calls = [
			{ name: "git_push", success: false, result: `Error: auth failed for ${ghp} at remote` },
		];
		const lines = review("push it", calls, "Pushed.");
		expect(lines).toEqual(["Not in the reply: git_push failed."]);
	});

	test("a secret in a failed command is redacted before the command is clipped", () => {
		const calls = [run(`curl -H "x: ${ghp}" https://example.test`, "Exit code 7:\n")];
		const lines = review("fetch it", calls, "Fetched.");
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("ghp_");
		expect(lines[0]).toContain("[REDACTED:git");
	});

	test("a secret in a file name is redacted", () => {
		const lines = review("Fix src/a.ts", [edit(`notes-${ghp}.ts`), run("bun test", " 1 pass")]);
		expect(lines.join("\n")).not.toContain(ghp);
		expect(lines.join("\n")).toContain("[REDACTED:github_token]");
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
