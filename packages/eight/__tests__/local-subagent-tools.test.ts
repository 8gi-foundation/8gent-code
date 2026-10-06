/**
 * #3583: a spawned sub-agent on the local text-tool path has one task, so it
 * gets no update_plan, and check_agent waits long enough that the parent stops
 * competing with its children for the one local model.
 *
 * Before: pilot orch-route-three (run 2026-10-06_093713, qwen3.8 27B) - 17 of
 * the children's 30 tool calls were update_plan, and the parent made 35
 * check_agent calls at a 20 s wait each, so the turn ran out at 1500 s.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../../tests/temp-dirs";
import { CHECK_AGENT_DESCRIPTION, checkAgentWaitMs } from "../../orchestration/delegation-tools";
import { localCatalogOmissions, localPlanTools } from "../local-tool-scope";
import { buildToolCatalogSegment } from "../prompts/system-prompt";

afterAll(cleanupTempDirs);

/** One real Agent turn, bound at `depth` the way the pool runs a child. */
function probeTurn(
	depth: number,
	message: string,
): { tools: string[]; system: string; lastUser: string } {
	const root = tempDir("local-subagent-");
	mkdirSync(join(root, "home"));
	mkdirSync(join(root, "work"));
	const r = Bun.spawnSync(
		[
			"bun",
			join(import.meta.dir, "fixtures", "local-turn-probe.ts"),
			"-",
			join(root, "work"),
			message,
			String(depth),
		],
		{ env: { ...process.env, HOME: join(root, "home") }, stdout: "pipe", stderr: "pipe" },
	);
	const line = r.stdout
		.toString()
		.split("\n")
		.find((l) => l.startsWith("@@PROBE@@"));
	if (!line)
		throw new Error(
			`probe printed no result (exit ${r.exitCode}): ${r.stderr.toString().slice(-800)}`,
		);
	return JSON.parse(line.slice("@@PROBE@@".length));
}

// Long enough, and with a build verb, to trip the planning gate.
const MULTI_STEP =
	"Fix the typo in ABOUT.md and add a line about the project goals at the end of the same file.";

describe("local sub-agents get no update_plan (#3583)", () => {
	test("plan tools follow the depth", () => {
		expect(localPlanTools(0)).toEqual(["update_plan"]);
		for (const depth of [1, 2, 3]) expect(localPlanTools(depth)).toEqual([]);
	});

	test("the catalog advertises update_plan only to a top-level agent", () => {
		expect(
			buildToolCatalogSegment({ concise: true, omit: localCatalogOmissions(undefined, 0) }),
		).toContain("update_plan");
		const child = buildToolCatalogSegment({
			concise: true,
			omit: localCatalogOmissions(undefined, 1),
		});
		expect(child).not.toContain("update_plan");
		expect(child).toContain("read_file");
		expect(child).toContain("edit_file");
	});

	test("real turn, top level: update_plan declared, advertised, and asked for", () => {
		const turn = probeTurn(0, MULTI_STEP);
		expect(turn.tools).toContain("update_plan");
		expect(turn.system).toContain("update_plan");
		expect(turn.lastUser).toContain("[PLANNING]");
		expect(turn.lastUser).toContain("update_plan");
	}, 60_000);

	test("real turn, spawned sub-agent: no update_plan anywhere it can see", () => {
		const turn = probeTurn(1, MULTI_STEP);
		expect(turn.tools).toContain("read_file");
		expect(turn.tools).toContain("edit_file");
		expect(turn.tools).not.toContain("update_plan");
		expect(turn.system).not.toContain("update_plan");
		// Still plans, still told to execute at once, never told to call a tool it lacks.
		expect(turn.lastUser).toContain("[PLANNING]");
		expect(turn.lastUser).toContain("IMMEDIATELY");
		expect(turn.lastUser).not.toContain("update_plan");
	}, 60_000);
});

describe("check_agent waits long enough to stop polling the shared model (#3583)", () => {
	const saved = process.env.EIGHT_CHECK_AGENT_WAIT_MS;
	afterEach(() => {
		if (saved === undefined) delete process.env.EIGHT_CHECK_AGENT_WAIT_MS;
		else process.env.EIGHT_CHECK_AGENT_WAIT_MS = saved;
	});

	test("default wait is 90 s, and the tool says so", () => {
		delete process.env.EIGHT_CHECK_AGENT_WAIT_MS;
		expect(checkAgentWaitMs()).toBe(90_000);
		expect(CHECK_AGENT_DESCRIPTION).toContain("waits up to 90s");
	});

	test("the env override still wins", () => {
		process.env.EIGHT_CHECK_AGENT_WAIT_MS = "0";
		expect(checkAgentWaitMs()).toBe(0);
		process.env.EIGHT_CHECK_AGENT_WAIT_MS = "5000";
		expect(checkAgentWaitMs()).toBe(5000);
	});
});
