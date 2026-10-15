import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
	test("same base name in two directories is two files", () => {
		expect(sourceFilesNamed("a/util.go and b/util.go").sort()).toEqual(["a/util.go", "b/util.go"]);
	});
	test("dotted product names are not files; a path or :line makes them one", () => {
		expect(sourceFilesNamed("Next.js, Node.js, vue.js and three.js")).toEqual([]);
		expect(sourceFilesNamed("server.js:12 and lib/app.js").sort()).toEqual([
			"lib/app.js",
			"server.js",
		]);
		expect(sourceFilesNamed("config.go and cors.go").sort()).toEqual(["config.go", "cors.go"]);
	});
	test("test files and test dirs are ignored", () => {
		expect(sourceFilesNamed("a.test.ts b.spec.ts c_test.go test/helper.go src/x.ts")).toEqual([
			"src/x.ts",
		]);
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
	test("refuses a UNC, home, drive or absolute name before any fs call", () => {
		const d = tmp();
		for (const n of [
			"\\\\host\\share\\b.md",
			"//host/share/b.md",
			"~/b.md",
			"C:\\b.md",
			"/etc/hosts",
		]) {
			expect(issueBodyOf(`gh issue create --body-file '${n}'`, d)).toBeNull();
		}
	});
	test("refuses a protected basename inside the working directory (.netrc)", () => {
		const d = tmp();
		fs.writeFileSync(path.join(d, ".netrc"), "alpha.py beta.go");
		expect(issueBodyOf("gh issue create --body-file .netrc", d)).toBeNull();
	});
	test("refuses a FIFO without blocking", () => {
		const d = tmp();
		spawnSync("mkfifo", [path.join(d, "f.md")]);
		expect(issueBodyOf("gh issue create --body-file f.md", d)).toBeNull();
	});
	test("refuses a hardlink to a file outside the working directory", () => {
		const d = tmp();
		const outside = tmp();
		fs.writeFileSync(path.join(outside, "s.md"), "alpha.py beta.go");
		fs.linkSync(path.join(outside, "s.md"), path.join(d, "h.md"));
		expect(issueBodyOf("gh issue create --body-file h.md", d)).toBeNull();
	});
	test("refuses a symlink and an oversize file", () => {
		const d = tmp();
		fs.writeFileSync(path.join(d, "real.md"), "x");
		fs.symlinkSync(path.join(d, "real.md"), path.join(d, "ln.md"));
		fs.writeFileSync(path.join(d, "big.md"), "x".repeat(70 * 1024));
		expect(issueBodyOf("gh issue create --body-file big.md", d)).toBeNull();
	});
	test("a stray -F in another command is not read", () => {
		const d = tmp();
		fs.writeFileSync(path.join(d, "log.txt"), "alpha.py beta.go");
		expect(issueBodyOf('tail -F log.txt; gh issue create --title t --body "fine"', d)).toBe("fine");
		expect(issueBodyOf("tail -F log.txt; ls", d)).toBeNull();
	});
	test("a cd prefix reads the body in that folder", () => {
		const d = tmp();
		fs.mkdirSync(path.join(d, "sub"));
		fs.writeFileSync(path.join(d, "sub/b.md"), "in sub");
		fs.writeFileSync(path.join(d, "b.md"), "at root");
		expect(issueBodyOf("cd sub && gh issue create --body-file b.md", d)).toBe("in sub");
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

describe("ToolExecutor paths (#4320)", () => {
	test("run_command: two-file body held, never reaches gh; trimmed body is not held and meets the permission layer", async () => {
		const { ToolExecutor } = await import("./tools");
		const d = tmp();
		fs.mkdirSync(path.join(d, ".tmp"));
		const ex = new ToolExecutor(d);
		const cmd = "gh issue create --repo o/r --title t --body-file .tmp/b.md";
		fs.writeFileSync(path.join(d, ".tmp/b.md"), PILOT_BODY);
		const held = (await ex.execute("run_command", { command: cmd })) as string;
		expect(held).toStartWith("[HOLD]");
		expect(held).toContain("internal/config/cors.go");
		fs.writeFileSync(path.join(d, ".tmp/b.md"), TRIMMED);
		const sent = (await ex.execute("run_command", { command: cmd })) as string;
		// No terminal here, so the network send is denied by policy: the gate let it through.
		expect(sent).toStartWith("[PERMISSION DENIED]");
		expect(sent).toContain("gh issue create");
	});
	test("gh_issue_create: a two-file body is held, a trimmed one is not", async () => {
		const { ToolExecutor } = await import("./tools");
		const ex = new ToolExecutor(tmp());
		const held = (await ex.execute("gh_issue_create", { title: "t", body: PILOT_BODY })) as string;
		expect(held).toStartWith("[HOLD]");
		const next = (await ex.execute("gh_issue_create", { title: "t", body: TRIMMED })) as string;
		expect(next).not.toStartWith("[HOLD]");
	});
});
