/**
 * #4301: env-setup-practice stopped after `mkdir -p inbox/notes inbox/docs
 * inbox/sheets` ran 3 times. Each run succeeded and printed only "Command
 * completed successfully.", so the model could not see it had worked. The
 * detector stopped the turn before any file moved. A repeat of calls that all
 * succeeded now gets a recoverable nudge first; failures and unknown outcomes
 * keep the old stop at 3.
 */
import { describe, expect, test } from "bun:test";
import { ToolLoopDetector, isQuietSuccess } from "./tool-loop-detector";

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

describe("isQuietSuccess classifier (#4301)", () => {
	test("failures and timeouts are never quiet successes", () => {
		expect(isQuietSuccess("run_command", "Exit code 1:\nboom\n")).toBe(false);
		expect(isQuietSuccess("run_command", "Exit code 127")).toBe(false);
		expect(isQuietSuccess("run_command", "TIMEOUT after 120s")).toBe(false);
	});
	test("empty output and the completed note are quiet successes", () => {
		expect(isQuietSuccess("run_command", "")).toBe(true);
		expect(isQuietSuccess("run_command", "Command completed successfully.")).toBe(true);
		expect(
			isQuietSuccess(
				"run_command",
				"Command completed successfully. It printed nothing. It wrote a.txt.",
			),
		).toBe(true);
	});
	test("normal output text is not", () => {
		expect(isQuietSuccess("run_command", "total 4\ndrwx foo")).toBe(false);
	});
	test("writes and other side-effecting tools are never nudged", () => {
		for (const t of ["write_file", "edit_file", "git_commit", "http_post", "append_file"]) {
			expect(isQuietSuccess(t, "OK")).toBe(false);
			expect(isQuietSuccess(t, "")).toBe(false);
		}
	});
	test("read-only tools nudge on clean output, not on errors", () => {
		expect(isQuietSuccess("read_file", "hello")).toBe(true);
		expect(isQuietSuccess("list_files", "a\nb")).toBe(true);
		expect(isQuietSuccess("read_file", "Error: ENOENT")).toBe(false);
	});
});

// agent.ts feeds record() with exactly `success && isQuietSuccess(tool, shown)` on the
// text path and `event.success && isQuietSuccess(tool, resultStr)` on the native path.
// Driving agent.ts needs a live model, so these drive that exact expression.
describe("both agent.ts paths stop a failing command at 3 (#4301)", () => {
	const run = (outcomes: Array<{ success: boolean; text: string }>) => {
		const d = new ToolLoopDetector();
		for (const o of outcomes)
			d.record("run_command", MKDIR, {
				succeeded: o.success && isQuietSuccess("run_command", o.text),
			});
		return d.check();
	};
	const failing = Array.from({ length: 3 }, () => ({
		success: true,
		text: "Exit code 1:\n\nfail",
	}));
	test("text path: exit 1 x3 stops", () => {
		const r = run(failing);
		expect(r?.type).toBe("repeat");
		expect(r?.recoverable).toBeUndefined();
	});
	test("native path: timeout x3 stops", () => {
		const r = run(Array.from({ length: 3 }, () => ({ success: true, text: "TIMEOUT after 120s" })));
		expect(r?.recoverable).toBeUndefined();
	});
});

test("a write-style tool with succeeded output stops at 3", () => {
	const d = new ToolLoopDetector();
	for (let i = 0; i < 3; i++) {
		d.record(
			"write_file",
			{ path: "a", content: "x" },
			{ succeeded: isQuietSuccess("write_file", "Wrote a") },
		);
	}
	const r = d.check();
	expect(r?.type).toBe("repeat");
	expect(r?.recoverable).toBeUndefined();
});
