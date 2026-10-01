/**
 * #3095: on the local text-tool path the Orchestrator registers spawn_agent,
 * check_agent and list_agents; Engineer, QA and role-less agents keep the lean
 * set, and no agent is told about a delegation tool it does not have.
 *
 * Before: every local agent's prompt advertised the whole orchestration
 * category while none of them registered it, so qwen3.8 called spawn_agent
 * and got "no tool named spawn_agent" (pilot l4-spawn-parallel-m5, #3091).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../../tests/temp-dirs";
import { DELEGATION_TOOLS, localCatalogOmissions, localDelegationTools } from "../local-tool-scope";
import { buildToolCatalogSegment } from "../prompts/system-prompt";
import { TOOL_CATEGORIES } from "../tool-registry";

// Remove the temp dirs tempDir() has recorded, this file's included (#3285).
afterAll(cleanupTempDirs);

const ORCHESTRATION_ONLY = (TOOL_CATEGORIES.orchestration ?? []).filter((t) => !DELEGATION_TOOLS.includes(t));

/** One real Agent turn in a child process with HOME in a temp dir and the network stubbed. */
function probeTurn(role: string | undefined): { tools: string[]; system: string } {
	const root = tempDir("local-delegation-");
	mkdirSync(join(root, "home"));
	mkdirSync(join(root, "work"));
	const r = Bun.spawnSync(
		["bun", join(import.meta.dir, "fixtures", "local-turn-probe.ts"), role ?? "-", join(root, "work")],
		{ env: { ...process.env, HOME: join(root, "home") }, stdout: "pipe", stderr: "pipe" },
	);
	const out = r.stdout.toString();
	const line = out.split("\n").find((l) => l.startsWith("@@PROBE@@"));
	if (!line) throw new Error(`probe printed no result (exit ${r.exitCode}): ${r.stderr.toString().slice(-800)}`);
	return JSON.parse(line.slice("@@PROBE@@".length));
}

describe("local delegation tools follow the role (#3095)", () => {
	test("only the Orchestrator registers the delegation tools", () => {
		expect(localDelegationTools("orchestrator")).toEqual(["spawn_agent", "check_agent", "list_agents"]);
		for (const role of ["engineer", "qa", undefined, "__spawned__"]) {
			expect(localDelegationTools(role)).toEqual([]);
		}
	});

	test("the catalog advertises exactly the registered delegation tools", () => {
		const orch = buildToolCatalogSegment({ concise: true, omit: localCatalogOmissions("orchestrator") });
		expect(orch).toContain("- **orchestration**: spawn_agent, check_agent, list_agents\n");
		for (const t of ORCHESTRATION_ONLY) expect(orch).not.toContain(t);

		const eng = buildToolCatalogSegment({ concise: true, omit: localCatalogOmissions("engineer") });
		expect(eng).not.toContain("orchestration");
		for (const t of TOOL_CATEGORIES.orchestration ?? []) expect(eng).not.toMatch(new RegExp(`\\b${t}\\b`));
		// Everything else is untouched.
		expect(eng).toContain("read_file");
		expect(eng).toContain("web_search");
	});

	test("real turn, Orchestrator: the three tools are declared and advertised", () => {
		const turn = probeTurn("orchestrator");
		for (const t of DELEGATION_TOOLS) {
			expect(turn.tools).toContain(t);
			expect(turn.system).toContain(t);
		}
		for (const t of ORCHESTRATION_ONLY) expect(turn.system).not.toMatch(new RegExp(`\\b${t}\\b`));
	}, 60_000);

	for (const role of ["engineer", "qa", undefined]) {
		test(`real turn, ${role ?? "no role"}: lean set, and nothing about delegation in the prompt`, () => {
			const turn = probeTurn(role);
			expect(turn.tools).toContain("read_file");
			for (const t of TOOL_CATEGORIES.orchestration ?? []) {
				expect(turn.tools).not.toContain(t);
				expect(turn.system).not.toMatch(new RegExp(`\\b${t}\\b`));
			}
		}, 60_000);
	}
});
