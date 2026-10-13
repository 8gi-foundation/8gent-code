/**
 * The rules that ask before an agent rewrites ~/.8gent/mcp.json (which
 * programs MCP may start) or ~/.8gent/policies.yaml (the rules) match where
 * the write really lands, not only the path as typed (#3474, 8SO round 2).
 * Before, "path contains .8gent/mcp.json" missed ".8gent/./mcp.json",
 * ".8gent//mcp.json" and a plain "mcp.json" written from inside ~/.8gent.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePolicy, resolvePolicyPath } from "./policy-engine";
import { ToolG8 } from "./toolg8";

const root = realpathSync(mkdtempSync(join(tmpdir(), "mcp-config-policy-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const dot8 = join(root, ".8gent");
mkdirSync(dot8);
const work = join(root, "work");
mkdirSync(work);
symlinkSync(dot8, join(work, "cfg"));
symlinkSync(join(dot8, "mcp.json"), join(work, "dangling.json")); // target does not exist yet

const asks = (action: string, path: string, cwd: string) => {
	const d = evaluatePolicy(action, { path, cwd });
	return (
		!d.allowed && d.requiresApproval === true && /mcp-config-and-policies/.test(d.reason ?? "")
	);
};

describe("resolved_path rules for mcp.json and policies.yaml", () => {
	const caught: Array<[string, string]> = [
		[`${dot8}/mcp.json`, work],
		[`${dot8}/./mcp.json`, work],
		[`${dot8}//mcp.json`, work],
		[`${root}/work/../.8gent/mcp.json`, work],
		[`${root.toUpperCase()}/.8GENT/MCP.JSON`, work],
		["mcp.json", dot8],
		["./mcp.json", dot8],
		["./policies.yaml", dot8],
		["cfg/mcp.json", work],
		["dangling.json", work],
	];
	for (const [path, cwd] of caught) {
		test(`write_file ${path.replace(root, "<root>")} from ${cwd.replace(root, "<root>")} asks`, () => {
			expect(asks("write_file", path, cwd)).toBe(true);
		});
	}

	test("delete_file asks for the same paths", () => {
		expect(asks("delete_file", "mcp.json", dot8)).toBe(true);
		expect(asks("delete_file", `${dot8}//policies.yaml`, work)).toBe(true);
	});

	test("other files are not caught", () => {
		expect(asks("write_file", "mcp.json", work)).toBe(false);
		expect(asks("write_file", "notes.md", dot8)).toBe(false);
		expect(asks("write_file", `${dot8}/settings.json`, work)).toBe(false);
	});

	test("a shell redirect is resolved against the executor's cwd, not the process's", () => {
		const g = (cwd: string) =>
			ToolG8.instance().gate("t", "run_command", { command: "echo {} > mcp.json", cwd });
		expect(g(dot8).allowed).toBe(false);
		expect(g(dot8).reason).toContain("mcp-config-and-policies");
		expect(g(work).allowed).toBe(true);
	});

	test("resolvePolicyPath follows a symlinked dir and a dangling symlink to its target", () => {
		expect(resolvePolicyPath("cfg/mcp.json", work)).toBe(join(dot8, "mcp.json"));
		expect(resolvePolicyPath("dangling.json", work)).toBe(join(dot8, "mcp.json"));
	});
});
