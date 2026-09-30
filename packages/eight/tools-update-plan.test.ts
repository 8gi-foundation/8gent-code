/**
 * update_plan (#3035) is reachable from both tool paths (ToolExecutor for
 * text-tool and local providers, the AI SDK registry for native ones), is a
 * core tool, executes nothing, and can never ground a completion claim.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { toolDefsToSpecs } from "../ai/text-tool-endpoint";
import { buildToolSystemPrompt } from "../ai/text-tools";
import { agentTools } from "../ai/tools";
import { PLAN_STATUSES, parsePlan, updatePlan } from "../ai/update-plan";
import { enforceAgenticHonesty } from "./honesty";
import { DEFAULT_SYSTEM_PROMPT, PLANNING_GATE_INSTRUCTION } from "./prompt";
import { TOOL_CATEGORIES } from "./tool-registry";
import { ToolExecutor } from "./tools";

const PLAN = [
	{ step: "Read the package", status: "done" },
	{ step: "Write the outline", status: "in_progress" },
	{ step: "Save it", status: "pending" },
];

describe("update_plan", () => {
	test("acknowledges with the counts and the current step", () => {
		expect(updatePlan({ plan: PLAN })).toBe(
			"Plan updated: 1 of 3 done. Current: Write the outline",
		);
		expect(updatePlan({ plan: [{ step: "A", status: "failed" }] })).toBe(
			"Plan updated: 0 of 1 done, 1 failed",
		);
	});

	test("a malformed plan is an Error: result, never a crash", () => {
		expect(updatePlan(undefined)).toStartWith("Error: update_plan:");
		expect(updatePlan({ plan: [] })).toStartWith("Error: update_plan:");
		expect(updatePlan({ plan: [{ step: "", status: "done" }] })).toContain("plan[0].step");
		expect(updatePlan({ plan: [{ step: "A", status: "maybe" }] })).toContain(
			"plan[0].status must be one of pending, in_progress, done, failed",
		);
	});

	test("the text path accepts the spellings models use for the same states", () => {
		const parsed = parsePlan([
			{ step: "A", status: "completed" },
			{ step: "B", status: "In-Progress" },
			{ step: "C", status: "todo" },
		]);
		expect(parsed.ok && parsed.items.map((s) => s.status)).toEqual([
			"done",
			"in_progress",
			"pending",
		]);
	});

	test("ToolExecutor defines and runs it, and it touches nothing on disk", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "update-plan-"));
		try {
			const executor = new ToolExecutor(root);
			const def = executor
				.getToolDefinitions()
				.map((d) => (d as { function: { name: string; parameters: unknown } }).function)
				.find((f) => f.name === "update_plan");
			expect(def).toBeDefined();
			expect(JSON.stringify(def?.parameters)).toContain(
				'"enum":["pending","in_progress","done","failed"]',
			);
			const before = fs.readdirSync(root);
			expect(await executor.execute("update_plan", { plan: PLAN })).toBe(
				"Plan updated: 1 of 3 done. Current: Write the outline",
			);
			expect(await executor.execute("update_plan", {})).toStartWith("Error: update_plan:");
			expect(fs.readdirSync(root)).toEqual(before);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("the AI SDK registry has it and answers the same way", async () => {
		expect(agentTools.update_plan.execute).toBeDefined();
		const out = await agentTools.update_plan.execute?.(
			{
				plan: PLAN as Array<{
					step: string;
					status: "pending" | "in_progress" | "done" | "failed";
				}>,
			},
			{ toolCallId: "t", messages: [] },
		);
		expect(out).toBe("Plan updated: 1 of 3 done. Current: Write the outline");
	});

	test("the text-tool catalog line a local model reads carries the argument shape", () => {
		const executor = new ToolExecutor(os.tmpdir());
		const prompt = buildToolSystemPrompt(
			toolDefsToSpecs(
				executor.getToolDefinitions() as Parameters<typeof toolDefsToSpecs>[0],
				new Set(["update_plan"]),
			),
		);
		const line = prompt.split("\n").find((l) => l.startsWith("update_plan("));
		expect(line).toBeDefined();
		expect(line).toContain("{step, status}");
		expect(line).toContain("pending, in_progress, done or failed");
		expect(line).not.toContain("…");
	});

	test("is a core tool", () => {
		expect(TOOL_CATEGORIES.core).toContain("update_plan");
	});

	test("marking every step done does not let a completion claim through", () => {
		const gate = enforceAgenticHonesty({
			content: "Done! I created deck.md with all five slides.",
			ledger: [
				{
					name: "update_plan",
					args: { plan: [{ step: "Create deck.md", status: "done" }] },
					success: true,
					result: "Plan updated: 1 of 1 done",
				},
			],
		});
		expect(gate.violated).toBe(true);
	});
});

/**
 * #3082: the PLAN column only ticks when the agent calls update_plan, and the
 * agent was never told to. These pin the instruction that tells it.
 */
describe("the agent is told to report plan progress", () => {
	test("the planning gate asks for the plan, execution, and update_plan reports", () => {
		expect(PLANNING_GATE_INSTRUCTION).toStartWith("[PLANNING]");
		expect(PLANNING_GATE_INSTRUCTION).toContain("PLAN: 1.");
		expect(PLANNING_GATE_INSTRUCTION).toContain("Do not stop after planning - execute.");
		expect(PLANNING_GATE_INSTRUCTION).toContain("call update_plan with every step");
		expect(PLANNING_GATE_INSTRUCTION).toContain("before your final answer");
	});

	test("every status the gate names is one update_plan accepts", () => {
		for (const status of PLAN_STATUSES) expect(PLANNING_GATE_INSTRUCTION).toContain(status);
		const plan = PLAN_STATUSES.map((status, i) => ({ step: `Step ${i + 1}`, status }));
		expect(parsePlan(plan).ok).toBe(true);
	});

	test("the BMAD rules say reporting progress is not re-planning", () => {
		expect(DEFAULT_SYSTEM_PROMPT).toContain("Reporting progress is not re-planning");
		expect(DEFAULT_SYSTEM_PROMPT.match(/update_plan/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
	});

	test("agent.ts injects the shared constant, not its own copy", () => {
		const src = fs.readFileSync(path.join(import.meta.dir, "agent.ts"), "utf8");
		expect(src).toContain("content: PLANNING_GATE_INSTRUCTION,");
		expect(src).not.toContain('"[PLANNING] ');
	});
});
