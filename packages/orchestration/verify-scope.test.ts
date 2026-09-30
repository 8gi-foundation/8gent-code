import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolExecutor } from "../eight/tools";
import { classifyRun, firstFailure, siblingTest, snapshotScope, verifyScope } from "./verify-scope";

// The real gated path: the same ToolExecutor run_command a sub-agent uses.
const gatedRunner = (wd: string) => {
	const ex = new ToolExecutor(wd, "primary", undefined, { openOnWrite: false });
	return (command: string, timeoutMs: number) =>
		ex.execute("run_command", { command, timeout: timeoutMs / 1000 });
};

describe("siblingTest", () => {
	test("maps a source file to its test, and nothing else", () => {
		expect(siblingTest("src/clamp.ts")).toBe("src/clamp.test.ts");
		expect(siblingTest("src/App.tsx")).toBe("src/App.test.tsx");
		expect(siblingTest("src/clamp.test.ts")).toBeNull();
		expect(siblingTest("README.md")).toBeNull();
	});
});

describe("firstFailure", () => {
	test("the first (fail) line, else the first error line", () => {
		expect(firstFailure("bun test\n(pass) a\n(fail) b > c [0.1ms]\n(fail) d")).toBe(
			"(fail) b > c [0.1ms]",
		);
		expect(firstFailure("\nerror: Cannot find module './x'\n")).toBe(
			"error: Cannot find module './x'",
		);
		expect(firstFailure("")).toBe("no output");
	});
});

describe("snapshotScope and verifyScope", () => {
	const dir = () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "verify-scope-"));
		fs.mkdirSync(path.join(d, "src"));
		fs.writeFileSync(path.join(d, "src", "a.ts"), "export const a = 1;\n");
		return d;
	};

	test("files are hashed; directories and paths outside the work dir are left out", () => {
		const d = dir();
		const snap = snapshotScope(d, ["src/a.ts", "src", "../outside.ts", "src/new.ts"]);
		expect(Object.keys(snap).sort()).toEqual(["src/a.ts", "src/new.ts"]);
		expect(snap["src/a.ts"]).toMatch(/^[0-9a-f]{64}$/);
		expect(snap["src/new.ts"]).toBeNull();
	});

	test("an identical rewrite is unchanged; a change with no test is unverified", async () => {
		const d = dir();
		const snap = snapshotScope(d, ["src/a.ts", "src/new.ts"]);
		fs.writeFileSync(path.join(d, "src", "a.ts"), "export const a = 1;\n");
		fs.writeFileSync(path.join(d, "src", "new.ts"), "export const n = 2;\n");
		expect(await verifyScope(d, snap, gatedRunner(d), 5000)).toEqual([
			{ file: "src/a.ts", state: "unchanged" },
			{ file: "src/new.ts", state: "unverified" },
		]);
	});

	test("a changed file with a passing sibling test is fixed; a failing one reports its first failure", async () => {
		const d = dir();
		fs.writeFileSync(
			path.join(d, "src", "a.test.ts"),
			'import { expect, test } from "bun:test";\nimport { a } from "./a";\ntest("a is 2", () => { expect(a).toBe(2); });\n',
		);
		const snap = snapshotScope(d, ["src/a.ts"]);
		fs.writeFileSync(path.join(d, "src", "a.ts"), "export const a = 3;\n");
		const [bad] = await verifyScope(d, snap, gatedRunner(d), 30_000);
		expect(bad).toMatchObject({ file: "src/a.ts", state: "test-fails", test: "src/a.test.ts" });
		expect((bad as { firstFailure: string }).firstFailure).toStartWith("(fail) a is 2");
		fs.writeFileSync(path.join(d, "src", "a.ts"), "export const a = 2;\n");
		expect(await verifyScope(d, snap, gatedRunner(d), 30_000)).toEqual([
			{ file: "src/a.ts", state: "fixed", test: "src/a.test.ts" },
		]);
	}, 60_000);
});

describe("classifyRun: FIXED needs positive evidence", () => {
	test("a clean bun test run passes; failures, timeouts and gate markers do not", () => {
		expect(classifyRun("bun test v1.3.14 (0d9b296a)\n")).toEqual({ kind: "pass" });
		expect(classifyRun("Exit code 1:\nbun test v1.3.14\n(fail) adds [0.1ms]\n")).toEqual({
			kind: "fail",
			firstFailure: "(fail) adds [0.1ms]",
		});
		expect(classifyRun("TIMEOUT after 60s. Partial output:\n")).toEqual({ kind: "timeout" });
		for (const blocked of [
			"[PERMISSION DENIED] Command blocked by security policy: bun test ./a.test.ts",
			"[SYSTEM ONE BLOCKED] looks risky",
			"[BLOCKED] command substitution",
			"[MAKER-CHECKER BLOCKED] needs a checker",
			"Command completed successfully.",
			"",
		]) {
			expect(classifyRun(blocked).kind).toBe("blocked");
		}
	});

	test("a runner that is blocked yields blocked, never fixed", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "verify-scope-blocked-"));
		fs.mkdirSync(path.join(d, "src"));
		fs.writeFileSync(path.join(d, "src", "a.ts"), "export const a = 1;\n");
		fs.writeFileSync(path.join(d, "src", "a.test.ts"), "// test\n");
		const snap = snapshotScope(d, ["src/a.ts"]);
		fs.writeFileSync(path.join(d, "src", "a.ts"), "export const a = 2;\n");
		const seen: string[] = [];
		const verdicts = await verifyScope(
			d,
			snap,
			async (command) => {
				seen.push(command);
				return "[SYSTEM ONE BLOCKED] not now";
			},
			1000,
		);
		expect(seen).toEqual(["bun test ./src/a.test.ts"]);
		expect(verdicts).toEqual([
			{
				file: "src/a.ts",
				state: "blocked",
				test: "src/a.test.ts",
				reason: "[SYSTEM ONE BLOCKED] not now",
			},
		]);
	});

	test("a test path with shell syntax is never put on a command line", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "verify-scope-unsafe-"));
		fs.writeFileSync(path.join(d, "a b.ts"), "x\n");
		fs.writeFileSync(path.join(d, "a b.test.ts"), "x\n");
		const snap = snapshotScope(d, ["a b.ts"]);
		fs.writeFileSync(path.join(d, "a b.ts"), "y\n");
		let ran = false;
		const verdicts = await verifyScope(d, snap, async () => {
			ran = true;
			return "bun test v1\n";
		});
		expect(ran).toBe(false);
		expect(verdicts).toEqual([{ file: "a b.ts", state: "unverified" }]);
	});
});
