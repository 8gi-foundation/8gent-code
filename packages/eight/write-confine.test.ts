/**
 * #3747: write_file and edit_file never touch a path outside the workspace
 * root, on either tool path, and `8gent run` makes its working directory the
 * workspace root unless the run opts out.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { agentTools, getToolContext, setToolContext } from "../ai/tools";
import { evaluatePolicy } from "../permissions/policy-engine";
import { CreatedFiles } from "../permissions/s1-created-files";
import { parseRunArgs, runWorkspaceRoot } from "./run";
import { ToolExecutor } from "./tools";

afterAll(cleanupTempDirs);

const priorContext = getToolContext();
afterEach(() => setToolContext(priorContext));

type Exec = (args: Record<string, unknown>, opts: unknown) => Promise<string>;
const nativeWrite = (args: Record<string, unknown>) =>
	(agentTools.write_file as unknown as { execute: Exec }).execute(args, { toolCallId: "t", messages: [] });
const nativeEdit = (args: Record<string, unknown>) =>
	(agentTools.edit_file as unknown as { execute: Exec }).execute(args, { toolCallId: "t", messages: [] });

/** A fresh workspace bound to the native tools, plus a directory outside it. */
function setup(): { ws: string; outside: string } {
	const ws = tempDir("confine-ws-");
	const outside = tempDir("confine-out-");
	setToolContext({ ...priorContext, workingDirectory: ws, createdFiles: new CreatedFiles() });
	return { ws, outside };
}

describe("native tool path (#3747)", () => {
	test("write_file refuses an absolute path outside the root and writes nothing", async () => {
		const { outside } = setup();
		const target = path.join(outside, "escaped.txt");
		const out = await nativeWrite({ path: target, content: "x" });
		expect(out).toContain("outside");
		expect(out).toContain("Nothing was written");
		expect(fs.existsSync(target)).toBe(false);
	});

	test("write_file refuses a relative path that climbs out of the root", async () => {
		const { ws } = setup();
		const out = await nativeWrite({ path: "../climbed-3747.txt", content: "x" });
		expect(out).toContain("Nothing was written");
		expect(fs.existsSync(path.join(ws, "..", "climbed-3747.txt"))).toBe(false);
	});

	test("edit_file refuses an absolute path outside the root and leaves the file alone", async () => {
		const { outside } = setup();
		const target = path.join(outside, "keep.txt");
		fs.writeFileSync(target, "hello world");
		const out = await nativeEdit({ path: target, oldText: "hello", newText: "bye" });
		expect(out).toContain("Nothing was written");
		expect(fs.readFileSync(target, "utf8")).toBe("hello world");
	});

	test("write_file writes a relative path inside the root", async () => {
		const { ws } = setup();
		const out = await nativeWrite({ path: "src/inside.txt", content: "ok" });
		expect(out).toContain("File written");
		expect(fs.readFileSync(path.join(ws, "src", "inside.txt"), "utf8")).toBe("ok");
	});

	test("edit_file edits a relative path inside the root", async () => {
		const { ws } = setup();
		fs.writeFileSync(path.join(ws, "a.txt"), "hello world");
		const out = await nativeEdit({ path: "a.txt", oldText: "hello", newText: "bye" });
		expect(out).toContain("File edited");
		expect(fs.readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("bye world");
	});
});

describe("text-tool path (#3747)", () => {
	test("write_file and edit_file refuse an absolute path outside the root", async () => {
		const ws = tempDir("confine-ws-");
		const outside = tempDir("confine-out-");
		const ex = new ToolExecutor(ws, "primary");
		const target = path.join(outside, "escaped.txt");
		await expect(ex.execute("write_file", { path: target, content: "x" })).rejects.toThrow("outside");
		expect(fs.existsSync(target)).toBe(false);

		fs.writeFileSync(target, "hello world");
		await expect(
			ex.execute("edit_file", { path: target, oldText: "hello", newText: "bye" }),
		).rejects.toThrow("outside");
		expect(fs.readFileSync(target, "utf8")).toBe("hello world");
	});

	test("write_file writes a relative path inside the root", async () => {
		const ws = tempDir("confine-ws-");
		const ex = new ToolExecutor(ws, "primary");
		const out = await ex.execute("write_file", { path: "inside.txt", content: "ok" });
		expect(String(out)).toContain("File written");
		expect(fs.readFileSync(path.join(ws, "inside.txt"), "utf8")).toBe("ok");
	});
});

describe("run mode sets the workspace root (#3747)", () => {
	test("on by default; --no-workspace-boundary turns it off", () => {
		expect(parseRunArgs(["do", "it"]).workspaceBoundary).toBe(true);
		expect(parseRunArgs(["--no-workspace-boundary", "do", "it"]).workspaceBoundary).toBe(false);
		expect(parseRunArgs(["--no-workspace-boundary", "do", "it"]).prompt).toBe("do it");
	});

	test("the root is the run's working directory, resolved", () => {
		expect(runWorkspaceRoot({ workspaceBoundary: true }, {}, "/w/repo")).toBe(path.resolve("/w/repo"));
		expect(runWorkspaceRoot({ workspaceBoundary: true, cwd: "sub" }, {}, "/w/repo")).toBe("/w/repo/sub");
		expect(runWorkspaceRoot({ workspaceBoundary: true, cwd: "/abs" }, {}, "/w/repo")).toBe("/abs");
	});

	test("a root already set is kept, and opting out sets nothing", () => {
		expect(
			runWorkspaceRoot({ workspaceBoundary: true }, { EIGHT_WORKSPACE_ROOT: "/mine" }, "/w/repo"),
		).toBeUndefined();
		expect(runWorkspaceRoot({ workspaceBoundary: false }, {}, "/w/repo")).toBeUndefined();
	});

	test("with the root set, the policy engine refuses a write outside it", () => {
		const ws = tempDir("confine-ws-");
		const prior = process.env.EIGHT_WORKSPACE_ROOT;
		const outsideTarget = "/etc/confine-3747.txt";
		try {
			delete process.env.EIGHT_WORKSPACE_ROOT;
			const root = runWorkspaceRoot({ workspaceBoundary: true, cwd: ws });
			expect(root).toBe(ws);
			process.env.EIGHT_WORKSPACE_ROOT = root;
			const decision = evaluatePolicy("write_file", { path: outsideTarget });
			expect(decision.allowed).toBe(false);
			expect(decision.allowed ? "" : String(decision.reason)).toContain("workspace-boundary");
			expect(evaluatePolicy("write_file", { path: path.join(ws, "ok.txt") }).allowed).toBe(true);
		} finally {
			if (prior === undefined) delete process.env.EIGHT_WORKSPACE_ROOT;
			else process.env.EIGHT_WORKSPACE_ROOT = prior;
		}
	});
});
