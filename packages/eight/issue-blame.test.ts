import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IssueBlameGate, issueBodyOf, sourceFilesNamed } from "./issue-blame";

// The body the issue-file-practice pilot model wrote on 2026-10-16 (run 000847).
const PILOT_BODY = [
	"## Failing test",
	"`TestWhitespaceCorsAllowedOrigins` in `internal/config/config_whitespace_test.go`.",
	"- `yaml_whitespace_splits_and_collapses` (`config_whitespace_test.go:22`)",
	"## Where the fix most likely lives",
	"`internal/config/config.go`, the `decodeHooks` composition (lines 15-22).",
	"The struct itself lives in `internal/config/cors.go` (`CorsConfig.AllowedOrigins`).",
	"Full output: `ci/last-run.log`.",
].join("\n");
const TRIMMED = PILOT_BODY.replace(/^The struct itself.*$/m, "");

const dirs: string[] = [];
function tmp(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "issue-blame-"));
	dirs.push(d);
	return d;
}
afterAll(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("sourceFilesNamed (#4320)", () => {
	test("the pilot body names config.go and cors.go; test file and log do not count", () => {
		expect(sourceFilesNamed(PILOT_BODY).sort()).toEqual([
			"internal/config/config.go",
			"internal/config/cors.go",
		]);
	});
	test("the trimmed body names one", () => {
		expect(sourceFilesNamed(TRIMMED)).toEqual(["internal/config/config.go"]);
	});
	test("a bare name and its full path are one file", () => {
		expect(sourceFilesNamed("see cors.go and internal/config/cors.go")).toEqual([
			"internal/config/cors.go",
		]);
	});
	test("test files and test dirs are ignored", () => {
		expect(sourceFilesNamed("a.test.ts b.spec.ts c_test.go test/helper.go x.ts")).toEqual(["x.ts"]);
	});
	test("a version number or domain is not a file", () => {
		expect(sourceFilesNamed("foo.com v1.2 node.js-runtime")).toEqual([]);
	});
});

describe("issueBodyOf", () => {
	test("reads --body-file inside the working directory", () => {
		const d = tmp();
		fs.mkdirSync(path.join(d, ".tmp"));
		fs.writeFileSync(path.join(d, ".tmp/b.md"), PILOT_BODY);
		const cmd = 'gh issue create --repo o/r --title "t" --label P1 --body-file .tmp/b.md';
		expect(issueBodyOf(cmd, d)).toBe(PILOT_BODY);
	});
	test("refuses a body file outside the working directory", () => {
		const d = tmp();
		const outside = tmp();
		fs.writeFileSync(path.join(outside, "b.md"), "x");
		expect(issueBodyOf(`gh issue create --body-file ${path.join(outside, "b.md")}`, d)).toBeNull();
	});
	test("reads an inline --body", () => {
		expect(issueBodyOf(`gh issue create --title t --body "fix a.go and b.go"`, tmp())).toBe(
			"fix a.go and b.go",
		);
	});
	test("other commands are not issue bodies", () => {
		expect(issueBodyOf("gh issue view 9 --json number", tmp())).toBeNull();
		expect(issueBodyOf("ls", tmp())).toBeNull();
	});
});

describe("IssueBlameGate", () => {
	test("holds a two-file body once, then lets the same set through", () => {
		const gate = new IssueBlameGate();
		const first = gate.check(PILOT_BODY);
		expect(first).toStartWith("[HOLD]");
		expect(first).toContain("internal/config/cors.go");
		expect(first).toContain("internal/config/config.go");
		expect(gate.check(PILOT_BODY)).toBeNull();
	});
	test("a trimmed body goes straight through", () => {
		expect(new IssueBlameGate().check(TRIMMED)).toBeNull();
	});
	test("a different two-file set is held again", () => {
		const gate = new IssueBlameGate();
		gate.check("a.go b.go");
		expect(gate.check("a.go c.go")).toStartWith("[HOLD]");
	});
});

describe("ToolExecutor run_command path (#4320)", () => {
	test("first two-file gh issue create is held and never reaches gh; trimmed one files", async () => {
		const { ToolExecutor } = await import("./tools");
		const d = tmp();
		fs.mkdirSync(path.join(d, ".tmp"));
		fs.mkdirSync(path.join(d, "bin"));
		const calls = path.join(d, "calls.log");
		fs.writeFileSync(
			path.join(d, "bin/gh"),
			`#!/bin/sh\necho "$@" >> ${calls}\necho https://x/issues/1\n`,
			{
				mode: 0o755,
			},
		);
		const oldPath = process.env.PATH;
		process.env.PATH = `${path.join(d, "bin")}:${oldPath}`;
		try {
			const ex = new ToolExecutor(d);
			const cmd = "gh issue create --repo o/r --title t --body-file .tmp/b.md";
			fs.writeFileSync(path.join(d, ".tmp/b.md"), PILOT_BODY);
			const held = (await ex.execute("run_command", { command: cmd })) as string;
			expect(held).toStartWith("[HOLD]");
			expect(fs.existsSync(calls)).toBe(false);
			fs.writeFileSync(path.join(d, ".tmp/b.md"), TRIMMED);
			const filed = (await ex.execute("run_command", { command: cmd })) as string;
			// Past the hold: it meets the permission layer (network send), not the gate.
			expect(filed).not.toStartWith("[HOLD]");
		} finally {
			process.env.PATH = oldPath;
		}
	});
});
