/**
 * #3472: EIGHT_EDIT_FORMAT=hashline through both tool catalogs. Flag on:
 * read_file rows carry anchors and edit_file takes them. Flag off: read_file,
 * edit_file and their definitions are exactly what they were before.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { toolDefsToSpecs } from "../ai/text-tool-endpoint";
import { buildToolSystemPrompt } from "../ai/text-tools";
import { extractAutoMemories } from "../memory";
import { lineHash } from "../tools/edit-anchor";
import { ToolExecutor, numberLines } from "./tools";

afterAll(cleanupTempDirs);

const SRC = "const a = 1;\nconst b  =  `x   y`;   // aligned\nconst c = 3;\n";
const LINES = SRC.split("\n").slice(0, 3);
const prior = process.env.EIGHT_EDIT_FORMAT;
let dir: string;
let ex: InstanceType<typeof ToolExecutor>;
const run = (tool: string, args: Record<string, unknown>) =>
	ex.execute(tool, args) as Promise<string>;
type Def = { function: { name: string; description: string; parameters: any } };
const def = (name: string) =>
	(ex.getToolDefinitions() as Def[]).find((d) => d.function.name === name) as Def;

beforeEach(() => {
	dir = tempDir("hashline-");
	fs.writeFileSync(path.join(dir, "a.ts"), SRC);
	ex = new ToolExecutor(dir);
});
afterEach(() => {
	if (prior === undefined) delete process.env.EIGHT_EDIT_FORMAT;
	else process.env.EIGHT_EDIT_FORMAT = prior;
});

describe("flag off (EIGHT_EDIT_FORMAT unset): unchanged", () => {
	beforeEach(() => delete process.env.EIGHT_EDIT_FORMAT);

	test("read_file is the plain cat -n gutter", async () => {
		expect(await run("read_file", { path: "a.ts" })).toBe(numberLines(LINES, 1));
	});

	test("edit_file ignores anchor and keeps the oldText contract and message", async () => {
		const out = await run("edit_file", {
			path: "a.ts",
			oldText: "const c = 3;",
			newText: "const c = 4;",
		});
		expect(out).toBe(`File edited: ${path.join(dir, "a.ts")}\nReplaced 12 chars with 12 chars.`);
		const anchored = await run("edit_file", {
			path: "a.ts",
			anchor: `1#${lineHash(LINES[0])}`,
			newText: "x",
		});
		expect(anchored).toContain("Error");
		expect(fs.readFileSync(path.join(dir, "a.ts"), "utf-8")).toBe(SRC.replace("c = 3", "c = 4"));
	});

	test("definitions are identical to any non-hashline value", () => {
		const off = JSON.stringify(ex.getToolDefinitions());
		process.env.EIGHT_EDIT_FORMAT = "patch";
		expect(JSON.stringify(ex.getToolDefinitions())).toBe(off);
		const edit = def("edit_file").function.parameters;
		expect(edit.required).toEqual(["path", "oldText", "newText"]);
		expect(edit.properties.anchor).toBeUndefined();
	});

	test("the native catalog keeps its legacy read_file and edit_file", async () => {
		const { agentTools } = await import("../ai/tools");
		expect((agentTools.edit_file as { description?: string }).description).toStartWith(
			"[FILE] Replaces oldText (exact existing line or block)",
		);
		expect((agentTools.read_file as { description?: string }).description).not.toContain("#hash");
	});
});

describe("flag on (EIGHT_EDIT_FORMAT=hashline)", () => {
	beforeEach(() => {
		process.env.EIGHT_EDIT_FORMAT = "hashline";
	});

	test("read_file rows carry N#hash, and memory still parses the file text", async () => {
		const out = await run("read_file", { path: "a.ts" });
		expect(out.split("\n")[1]).toBe(`     2#${lineHash(LINES[1])}\t${LINES[1]}`);
		const sliced = await run("read_file", { path: "a.ts", offset: 3, limit: 1 });
		expect(sliced).toBe(`     3#${lineHash(LINES[2])}\t${LINES[2]}`);
		fs.writeFileSync(path.join(dir, "package.json"), '{"name":"hl-demo","version":"1.0.0"}\n');
		const pkg = await run("read_file", { path: "package.json" });
		const facts = extractAutoMemories("read_file", { path: "package.json" }, pkg);
		expect(JSON.stringify(facts)).toContain("hl-demo");
	});

	test("edit_file replaces the anchored interior-whitespace line; a stale anchor refuses", async () => {
		const anchor = (await run("read_file", { path: "a.ts" })).split("\n")[1].split("\t")[0].trim();
		const ok = await run("edit_file", { path: "a.ts", anchor, newText: "const b = 2;" });
		expect(ok).toContain("Replaced lines 2-2 (1) with 1 line(s).");
		expect(fs.readFileSync(path.join(dir, "a.ts"), "utf-8")).toBe(
			"const a = 1;\nconst b = 2;\nconst c = 3;\n",
		);
		const stale = await run("edit_file", { path: "a.ts", anchor, newText: "nope" });
		expect(stale).toMatch(/line 2 of .*a\.ts changed since read_file/);
		expect(fs.readFileSync(path.join(dir, "a.ts"), "utf-8")).toContain("const b = 2;");
	});

	test("oldText still works with the flag on", async () => {
		const out = await run("edit_file", {
			path: "a.ts",
			oldText: "const a = 1;",
			newText: "const a = 0;",
		});
		expect(out).toStartWith("File edited:");
	});

	test("the catalog line names anchor, path and newText in its first 140 chars", () => {
		const specs = toolDefsToSpecs([def("edit_file"), def("read_file")] as never);
		const lines = buildToolSystemPrompt(specs).split("\n");
		const edit = lines.find((l) => l.startsWith("edit_file(")) as string;
		expect(edit).toStartWith(
			"edit_file(path: string, anchor?: string, newText: string, oldText?: string",
		);
		const desc = edit.slice(edit.indexOf(") - ") + 4);
		expect(desc).not.toContain("…");
		for (const w of ["anchor", "path", "newText", "in place"])
			expect(desc.slice(0, 140)).toContain(w);
		const read = lines.find((l) => l.startsWith("read_file(")) as string;
		expect(read).toContain("N#hash");
		expect(read).not.toContain("…");
	});

	test("the native catalog (picked at load) reads and edits by anchor", () => {
		const script = path.join(dir, "native.ts");
		const tools = path.join(import.meta.dir, "../ai/tools.ts");
		fs.writeFileSync(
			script,
			`import { agentTools, setToolContext } from ${JSON.stringify(tools)};
setToolContext({ workingDirectory: ${JSON.stringify(dir)} });
const call = (t: string, a: unknown) => (agentTools as any)[t].execute(a, { toolCallId: "t", messages: [] });
const read = await call("read_file", { path: "a.ts" });
const anchor = read.split("\\n")[2].split("\\t")[0].trim();
const edit = await call("edit_file", { path: "a.ts", anchor, newText: "const c = 9;" });
const byText = await call("edit_file", { path: "a.ts", oldText: "const a = 1;", newText: "const a = 0;" });
console.log(JSON.stringify({ desc: (agentTools as any).edit_file.description, read, edit, byText }));`,
		);
		const res = Bun.spawnSync([process.execPath, script], {
			env: { ...process.env, EIGHT_EDIT_FORMAT: "hashline" },
		});
		const out = JSON.parse(res.stdout.toString().trim().split("\n").pop() as string);
		expect(out.desc).toStartWith("[FILE] Replaces the lines at anchor");
		expect(out.read.split("\n")[0]).toBe(`     1#${lineHash(LINES[0])}\t${LINES[0]}`);
		expect(out.edit).toContain("Replaced lines 3-3 (1) with 1 line(s).");
		expect(out.byText).toStartWith("File edited:");
		expect(fs.readFileSync(path.join(dir, "a.ts"), "utf-8")).toBe(
			"const a = 0;\nconst b  =  `x   y`;   // aligned\nconst c = 9;\n",
		);
	});
});
