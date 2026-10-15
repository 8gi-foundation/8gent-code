/**
 * #4301: env-setup-practice stopped after `mkdir -p inbox/notes inbox/docs
 * inbox/sheets` ran 3 times. Each run succeeded and printed only "Command
 * completed successfully.", so the model could not see it had worked. The
 * detector stopped the turn before any file moved. A repeat of calls that all
 * succeeded now gets a recoverable nudge first; failures and unknown outcomes
 * keep the old stop at 3.
 */
import { describe, expect, test } from "bun:test";
import { ToolLoopDetector } from "./tool-loop-detector";

const MKDIR = { command: "mkdir -p inbox/notes inbox/docs inbox/sheets" };

describe("ToolLoopDetector: repeated successes (#4301)", () => {
	test("3 identical successful calls nudge, they do not stop", () => {
		const d = new ToolLoopDetector();
		for (let i = 0; i < 3; i++) d.record("run_command", MKDIR, { succeeded: true });
		const r = d.check();
		expect(r?.type).toBe("repeat");
		expect(r?.recoverable).toBe(true);
		expect(r?.message).toContain("already worked");
		expect(r?.message).toContain("next step");
	});

	test("the 4th identical success still nudges, the 5th stops", () => {
		const d = new ToolLoopDetector();
		for (let i = 0; i < 4; i++) d.record("run_command", MKDIR, { succeeded: true });
		expect(d.check()?.recoverable).toBe(true);
		d.record("run_command", MKDIR, { succeeded: true });
		const r = d.check();
		expect(r?.type).toBe("repeat");
		expect(r?.recoverable).toBeUndefined();
	});

	test("identical FAILED calls still stop at 3", () => {
		const d = new ToolLoopDetector();
		for (let i = 0; i < 3; i++) d.record("run_command", MKDIR, { succeeded: false });
		expect(d.check()?.recoverable).toBeUndefined();
		expect(d.check()?.type).toBe("repeat");
	});

	test("calls with no outcome recorded keep the old stop at 3", () => {
		const d = new ToolLoopDetector();
		for (let i = 0; i < 3; i++) d.record("run_command", MKDIR);
		expect(d.check()?.recoverable).toBeUndefined();
	});

	test("a refused call never counts as a success", () => {
		const d = new ToolLoopDetector();
		for (let i = 0; i < 3; i++) d.record("run_command", MKDIR, { refused: true, succeeded: true });
		expect(d.check()?.recoverable).toBeUndefined();
	});

	test("one failure in the streak makes it a stop", () => {
		const d = new ToolLoopDetector();
		d.record("run_command", MKDIR, { succeeded: false });
		d.record("run_command", MKDIR, { succeeded: true });
		d.record("run_command", MKDIR, { succeeded: true });
		expect(d.check()?.recoverable).toBeUndefined();
	});
});
