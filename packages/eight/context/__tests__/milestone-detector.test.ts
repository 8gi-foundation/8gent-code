import { describe, expect, it } from "bun:test";
import { MilestoneDetector } from "../milestone-detector";

describe("MilestoneDetector", () => {
	const d = new MilestoneDetector();

	it("emits file_written for Write tool", () => {
		const m = d.fromToolCall({
			name: "Write",
			args: { file_path: "src/x.ts" },
			success: true,
		});
		expect(m?.kind).toBe("file_written");
		expect(m?.signal).toBe("src/x.ts");
		expect(m?.confidence).toBeGreaterThan(0.9);
	});

	it("downgrades file_written confidence when the write failed", () => {
		const m = d.fromToolCall({
			name: "Write",
			args: { file_path: "src/x.ts" },
			success: false,
		});
		expect(m?.confidence).toBeLessThan(0.5);
	});

	it("emits test_passed for bun test with passing output", () => {
		const m = d.fromToolCall({
			name: "Bash",
			args: { command: "bun test" },
			resultPreview: "5 passed, 0 failed",
			success: true,
		});
		expect(m?.kind).toBe("test_passed");
	});

	it("emits test_failed for bun test with failing output", () => {
		const m = d.fromToolCall({
			name: "Bash",
			args: { command: "bun test" },
			resultPreview: "1 failed, 4 passed",
			success: false,
		});
		expect(m?.kind).toBe("test_failed");
	});

	it("returns null for tools that don't have a recognised milestone", () => {
		expect(d.fromToolCall({ name: "Glob", args: {}, success: true })).toBeNull();
	});

	it("detects task_complete and decision in assistant text", () => {
		const milestones = d.fromAssistantText("Task complete. I'll go with bun for the runner.");
		expect(milestones.some((m) => m.kind === "task_complete")).toBe(true);
		expect(milestones.some((m) => m.kind === "decision_recorded")).toBe(true);
	});
});
