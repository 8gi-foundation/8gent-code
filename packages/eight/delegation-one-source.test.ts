/**
 * spawn_agent / check_agent / list_agents have one implementation for both
 * tool paths (packages/orchestration/delegation-tools.ts). Before this, the
 * native AI SDK copy in packages/ai/tools.ts dropped allowedPaths and had none
 * of check_agent's outcome signals (#3112), so a native-path Orchestrator could
 * neither scope a sub-agent nor learn that one ended without doing its task.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentTools } from "../ai/tools";
import {
	CHECK_AGENT_DESCRIPTION,
	LIST_AGENTS_DESCRIPTION,
	SPAWN_AGENT_DESCRIPTION,
} from "../orchestration/delegation-tools";
import { shouldUseTextTools } from "./agent";
import { ToolExecutor } from "./tools";

type TextDef = {
	function: {
		name: string;
		description: string;
		parameters: { properties: Record<string, unknown> };
	};
};
function textDef(name: string) {
	const defs = new ToolExecutor(os.tmpdir()).getToolDefinitions() as TextDef[];
	const def = defs.find((d) => d.function.name === name);
	if (!def) throw new Error(`no text-path definition for ${name}`);
	return def.function;
}

describe("one source for the delegation tools", () => {
	test("both paths carry the same descriptions", () => {
		expect(agentTools.spawn_agent.description).toBe(SPAWN_AGENT_DESCRIPTION);
		expect(agentTools.check_agent.description).toBe(CHECK_AGENT_DESCRIPTION);
		expect(agentTools.list_agents.description).toBe(LIST_AGENTS_DESCRIPTION);
		expect(textDef("spawn_agent").description).toBe(SPAWN_AGENT_DESCRIPTION);
		expect(textDef("check_agent").description).toBe(CHECK_AGENT_DESCRIPTION);
		expect(textDef("list_agents").description).toBe(LIST_AGENTS_DESCRIPTION);
	});

	test("the native spawn_agent schema offers allowedPaths", () => {
		const shape = (
			agentTools.spawn_agent.inputSchema as unknown as { shape: Record<string, unknown> }
		).shape;
		expect(Object.keys(shape)).toContain("allowedPaths");
		expect(Object.keys(textDef("spawn_agent").parameters.properties)).toContain("allowedPaths");
	});

	test("native path, end to end: the scope reaches the sub-agent and check_agent says it did nothing", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-delegation-"));
		fs.mkdirSync(path.join(dir, "src"));
		fs.writeFileSync(path.join(dir, "src", "wordcount.ts"), "export const x = 1;\n");
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "native-delegation-home-"));
		const r = Bun.spawnSync(
			[
				"bun",
				path.join(import.meta.dir, "__tests__", "fixtures", "native-delegation-probe.ts"),
				dir,
			],
			{
				env: { ...process.env, HOME: home, EIGHT_CHECK_AGENT_WAIT_MS: "0" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const line = r.stdout
			.toString()
			.split("\n")
			.find((l) => l.startsWith("@@PROBE@@"));
		if (!line)
			throw new Error(
				`probe printed no result (exit ${r.exitCode}): ${r.stderr.toString().slice(-800)}`,
			);
		const out = JSON.parse(line.slice("@@PROBE@@".length));
		expect(out.poolScope).toEqual(["src/wordcount.ts"]);
		expect(out.spawned.allowedPaths).toEqual(["src/wordcount.ts"]);
		expect(out.checked.status).toBe("completed");
		expect(out.checked.filesChanged).toEqual([]);
		expect(out.checked.outcome).toStartWith("ENDED WITHOUT CHANGING src/wordcount.ts.");
	}, 60_000);
});

describe("a scoped agent always runs the text path, where the scope is enforced", () => {
	test("EIGHT_TEXT_TOOLS=0 cannot move a scoped agent onto the native tools", () => {
		const saved = process.env.EIGHT_TEXT_TOOLS;
		process.env.EIGHT_TEXT_TOOLS = "0";
		try {
			expect(shouldUseTextTools("ollama")).toBe(false);
			expect(shouldUseTextTools("ollama", true)).toBe(true);
			expect(shouldUseTextTools("anthropic", true)).toBe(true);
		} finally {
			if (saved === undefined) delete process.env.EIGHT_TEXT_TOOLS;
			else process.env.EIGHT_TEXT_TOOLS = saved;
		}
	});
});
