/**
 * The TUI default mode sends no [Mode:] prefix (apps/tui/src/app.tsx). The system
 * prompt used to call Planning "Default mode" with "output a plan", and cloud runs
 * explored, then stopped with no deliverable (#4448). The default must do the task;
 * plan-only applies only when [Mode: Planning] is explicitly present.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_SYSTEM_PROMPT } from "./prompt";

const lines = DEFAULT_SYSTEM_PROMPT.split("\n");
const defaultLine = lines.find((l) => l.startsWith("If no mode prefix is present")) ?? "";
const planningLine = lines.find((l) => l.startsWith("- **[Mode: Planning]**")) ?? "";

describe("default mode instruction (#4448)", () => {
	test("the default mode tells the model to complete the task, not to output a plan", () => {
		expect(defaultLine).not.toBe("");
		expect(defaultLine).toContain("complete the task");
		expect(defaultLine).toContain("short summary");
		expect(defaultLine).not.toContain("output a plan");
	});

	test("no mode line is labelled as the default plan mode", () => {
		expect(DEFAULT_SYSTEM_PROMPT).not.toContain("output a plan. Default mode");
		expect(planningLine).not.toContain("Default mode");
	});

	test("an explicit plan mode still says plan", () => {
		expect(planningLine).toContain("output a plan");
		expect(planningLine).toContain("only when this prefix is present");
	});
});
