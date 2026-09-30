/**
 * #3101: two write guards for sub-agents, from pilot run 2026-09-30_063150
 * (l4-spawn-parallel-m5). A llama3.2:3b sub-agent told to fix only
 * src/clamp.ts rewrote README.md, then called edit_file on the other agent's
 * src/wordcount.ts with oldText "" and prepended "# twofix" to it.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentTools, getToolContext, setToolContext } from "../ai/tools";
import { editScopeViolation, emptyOldTextError, normaliseAllowedPaths } from "../permissions/edit-guards";
import { ToolExecutor } from "./tools";

const WORDCOUNT = 'export function wordCount(text: string): number {\n\treturn text.split(" ").length;\n}\n';
const CLAMP = "export function clamp(n: number, min: number, max: number): number {\n\treturn Math.max(max, Math.min(n, min));\n}\n";
const README = "# twofix\n\nTwo small helpers.\n";

/** The twofix fixture in a fresh temp dir. */
function twofix(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-guards-"));
	fs.mkdirSync(path.join(dir, "src"));
	fs.writeFileSync(path.join(dir, "src", "wordcount.ts"), WORDCOUNT);
	fs.writeFileSync(path.join(dir, "src", "clamp.ts"), CLAMP);
	fs.writeFileSync(path.join(dir, "README.md"), README);
	return dir;
}
const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), "utf-8");

describe("edit_file refuses an empty oldText (#3101)", () => {
	for (const oldText of ["", "   ", "\n\t"]) {
		test(`text-tool path: oldText ${JSON.stringify(oldText)} changes nothing`, async () => {
			const dir = twofix();
			const out = await new ToolExecutor(dir).execute("edit_file", {
				path: "src/wordcount.ts",
				oldText,
				newText: "# twofix",
			});
			expect(read(dir, "src/wordcount.ts")).toBe(WORDCOUNT);
			expect(out).toMatch(/^Error: edit_file on \S*src\/wordcount\.ts did NOT run\./);
			expect(out).toContain("write_file");
			expect(out).toContain("non-empty");
		});
	}

	test("native path: the same refusal, and the file is untouched", async () => {
		const dir = twofix();
		const saved = getToolContext();
		setToolContext({ workingDirectory: dir });
		try {
			const out = await agentTools.edit_file.execute?.(
				{ path: "src/wordcount.ts", oldText: "", newText: "# twofix" },
				{ toolCallId: "t", messages: [] },
			);
			expect(String(out)).toStartWith("Error: edit_file on src/wordcount.ts did NOT run.");
			expect(read(dir, "src/wordcount.ts")).toBe(WORDCOUNT);
		} finally {
			setToolContext(saved);
		}
	});

	test("a real anchor still edits", async () => {
		const dir = twofix();
		const out = await new ToolExecutor(dir).execute("edit_file", {
			path: "src/clamp.ts",
			oldText: "Math.max(max, Math.min(n, min))",
			newText: "Math.min(Math.max(n, min), max)",
		});
		expect(out).toContain("File edited");
		expect(read(dir, "src/clamp.ts")).toContain("Math.min(Math.max(n, min), max)");
	});
});

describe("a spawned agent's edit scope is enforced (#3101)", () => {
	const scoped = (dir: string) =>
		new ToolExecutor(dir, "__spawned__", undefined, { allowedPaths: ["src/clamp.ts"] });

	test("the pilot's two out-of-scope writes are refused and never run", async () => {
		const dir = twofix();
		const ex = scoped(dir);
		const readme = await ex.execute("write_file", { path: "README.md", content: "# rewritten\n" });
		const other = await ex.execute("edit_file", {
			path: "src/wordcount.ts",
			oldText: "export",
			newText: "# twofix\nexport",
		});
		for (const out of [readme, other]) {
			expect(out).toStartWith("[SCOPE BLOCKED]");
			expect(out).toContain("did NOT run");
			expect(out).toContain("src/clamp.ts");
		}
		expect(read(dir, "README.md")).toBe(README);
		expect(read(dir, "src/wordcount.ts")).toBe(WORDCOUNT);
	});

	test("paths that resolve outside the scope are refused too", async () => {
		const dir = twofix();
		const ex = scoped(dir);
		for (const p of ["./src/../README.md", path.join(dir, "README.md"), "src/clamp.ts.bak", "src"]) {
			const out = await ex.execute("edit_file", { path: p, oldText: "x", newText: "y" });
			expect(out).toStartWith("[SCOPE BLOCKED]");
		}
	});

	test("the file in scope is edited normally, by relative or absolute path", async () => {
		const dir = twofix();
		const ex = scoped(dir);
		const a = await ex.execute("edit_file", {
			path: "./src/clamp.ts",
			oldText: "Math.max(max, Math.min(n, min))",
			newText: "Math.min(Math.max(n, min), max)",
		});
		expect(a).toContain("File edited");
		const b = await ex.execute("edit_file", {
			path: path.join(dir, "src", "clamp.ts"),
			oldText: "return",
			newText: "return /* clamped */",
		});
		expect(b).toContain("File edited");
		expect(read(dir, "src/clamp.ts")).toContain("/* clamped */ Math.min(Math.max(n, min), max)");
	});

	test("a directory in scope allows the files under it", async () => {
		const dir = twofix();
		const ex = new ToolExecutor(dir, "__spawned__", undefined, { allowedPaths: ["src"] });
		const out = await ex.execute("edit_file", { path: "src/wordcount.ts", oldText: "export", newText: "export" });
		expect(out).toContain("File edited");
		const readme = await ex.execute("edit_file", { path: "README.md", oldText: "#", newText: "#" });
		expect(readme).toStartWith("[SCOPE BLOCKED]");
	});

	test("reads are never limited, and no scope means no limit (opt-in)", async () => {
		const dir = twofix();
		expect(await scoped(dir).execute("read_file", { path: "README.md" })).toContain("twofix");
		const free = await new ToolExecutor(dir).execute("edit_file", {
			path: "README.md",
			oldText: "Two small helpers.",
			newText: "Two small, independent helpers.",
		});
		expect(free).toContain("File edited");
	});
});

describe("edit-guards helpers", () => {
	test("emptyOldTextError is null for a real anchor", () => {
		expect(emptyOldTextError("x")).toBeNull();
		expect(emptyOldTextError(undefined)).not.toBeNull();
	});
	test("normaliseAllowedPaths: arrays, comma strings, and nothing", () => {
		expect(normaliseAllowedPaths(["src/a.ts", " ", 3])).toEqual(["src/a.ts"]);
		expect(normaliseAllowedPaths("src/a.ts, src/b.ts")).toEqual(["src/a.ts", "src/b.ts"]);
		expect(normaliseAllowedPaths(undefined)).toBeUndefined();
		expect(normaliseAllowedPaths([])).toBeUndefined();
	});
	test("editScopeViolation ignores tools that do not write a file", () => {
		expect(editScopeViolation("read_file", { path: "README.md" }, "/w", ["src/a.ts"])).toBeNull();
		expect(editScopeViolation("run_command", { command: "ls" }, "/w", ["src/a.ts"])).toBeNull();
	});
	test("the spawn_agent definition offers allowedPaths", () => {
		const defs = new ToolExecutor(os.tmpdir()).getToolDefinitions() as Array<{
			function: { name: string; parameters: { properties: Record<string, unknown> } };
		}>;
		const spawn = defs.find((d) => d.function.name === "spawn_agent");
		expect(spawn?.function.parameters.properties.allowedPaths).toBeDefined();
	});
});

/**
 * The real spawn path in a child process (temp HOME, stubbed model): the
 * Orchestrator's executor calls spawn_agent, the agent pool builds the
 * sub-agent, and the sub-agent repeats the pilot's out-of-scope writes.
 */
function spawnProbe(allowedPaths: string[] | undefined) {
	const dir = twofix();
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-guards-home-"));
	const r = Bun.spawnSync(
		[
			"bun",
			path.join(import.meta.dir, "__tests__", "fixtures", "scoped-spawn-probe.ts"),
			dir,
			allowedPaths ? JSON.stringify(allowedPaths) : "-",
		],
		{ env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
	);
	const line = r.stdout
		.toString()
		.split("\n")
		.find((l) => l.startsWith("@@PROBE@@"));
	if (!line) throw new Error(`probe printed no result (exit ${r.exitCode}): ${r.stderr.toString().slice(-800)}`);
	return JSON.parse(line.slice("@@PROBE@@".length)) as {
		status: string;
		results: string[];
		readme: string;
		wordcount: string;
		clamp: string;
	};
}

describe("spawn_agent allowedPaths, end to end through the agent pool (#3101)", () => {
	test("the sub-agent fixes its own file; its README and cross-file writes are refused", () => {
		const out = spawnProbe(["src/clamp.ts"]);
		expect(out.status).toBe("completed");
		expect(out.readme).toBe(README);
		expect(out.wordcount).toBe(WORDCOUNT);
		expect(out.clamp).toContain("Math.min(Math.max(n, min), max)");
		const fed = out.results.join("\n");
		expect(fed).toContain("Tool write_file returned:\n[SCOPE BLOCKED] write_file did NOT run.");
		expect(fed).toContain("Tool edit_file returned:\n[SCOPE BLOCKED] edit_file did NOT run.");
	}, 60_000);

	test("without allowedPaths nothing is limited (opt-in)", () => {
		const out = spawnProbe(undefined);
		expect(out.status).toBe("completed");
		expect(out.readme).toContain("rewritten by the clamp agent");
		expect(out.wordcount).toContain("// clamp agent was here");
		expect(out.results.join("\n")).not.toContain("SCOPE BLOCKED");
	}, 60_000);
});
