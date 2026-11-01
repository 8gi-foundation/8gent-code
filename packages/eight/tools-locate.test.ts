/**
 * The locate tool is reachable from both tool paths the agent uses: the
 * ToolExecutor (text-tool and local providers) and the AI SDK registry
 * (native providers), it is a core tool, and its results are cacheable.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentTools, getToolContext, setToolContext } from "../ai/tools";
import { clearIndex, ensureIndexed } from "../ast-index";
import { TOOL_CATEGORIES, isReadOnlyTool } from "./tool-registry";
import { ToolExecutor } from "./tools";

let root: string;
let executor: ToolExecutor;

beforeAll(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "tools-locate-"));
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(root, "src", "gate.ts"),
		"// gate\nexport function widgetGate(x: number) {\n\treturn 'widget gate closed';\n}\n",
	);
	executor = new ToolExecutor(root);
	await ensureIndexed(root);
});

afterAll(() => {
	clearIndex(root);
	fs.rmSync(root, { recursive: true, force: true });
});

describe("locate tool", () => {
	test("is defined next to search_symbols with a query parameter", () => {
		const names = executor
			.getToolDefinitions()
			.map((d) => (d as { function: { name: string } }).function.name);
		expect(names).toContain("locate");
		expect(names.indexOf("locate")).toBe(names.indexOf("search_symbols") + 1);
	});

	test("ToolExecutor answers with file:line rows", async () => {
		const out = await executor.execute("locate", { query: "widgetGate" });
		expect(out.split("\n")[0]).toBe("locate symbol (identifier): widgetGate");
		expect(out).toContain("src/gate.ts:2 function function widgetGate(x: number)");
		const grep = await executor.execute("locate", { query: '"widget gate closed"' });
		expect(grep).toContain("src/gate.ts:3 match");
		const file = await executor.execute("locate", { query: "gate.ts" });
		expect(file).toContain("src/gate.ts:1 file 1 symbols: widgetGate");
	});

	test("a missing query is an error, not a crash", async () => {
		expect(await executor.execute("locate", {})).toContain("no matches");
	});

	test("is a core, read-only (cacheable) tool", () => {
		expect(TOOL_CATEGORIES.core).toContain("locate");
		expect(isReadOnlyTool("locate")).toBe(true);
	});

	test("the AI SDK registry has it and answers the same way", async () => {
		const before = getToolContext();
		setToolContext({ ...before, workingDirectory: root });
		try {
			expect(agentTools.locate.execute).toBeDefined();
			const out = await agentTools.locate.execute?.(
				{ query: "widgetGate" },
				{ toolCallId: "t", messages: [] },
			);
			expect(out).toContain("src/gate.ts:2 function");
		} finally {
			setToolContext(before);
		}
	});
});
