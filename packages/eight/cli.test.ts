import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyEffortPolicy } from "../providers/effort-policy";
import { CLI_TASK_KINDS, buildCLIChatRequest, parseCLIArgs } from "./cli";

const ON = { EIGHT_EFFORT_POLICY: "1" };

describe("--cli --task-kind", () => {
	test("each accepted kind reaches applyEffortPolicy and sets thinking when the flag is on", () => {
		const expected = { simple: "low", code: "medium", reasoning: "high", review: "high" };
		for (const kind of CLI_TASK_KINDS) {
			const opts = parseCLIArgs(["--cli", "--task-kind", kind, "hello"]);
			expect(opts?.taskKind).toBe(kind);
			expect(opts?.taskKindError).toBeUndefined();
			const req = buildCLIChatRequest(opts!);
			expect(req.taskKind).toBe(kind);
			expect(applyEffortPolicy(req, ON).thinking).toBe(expected[kind] as never);
		}
	});

	test("--task-kind=<kind> form works and is not taken as prompt text", () => {
		const opts = parseCLIArgs(["--cli", "--task-kind=review", "find", "the", "bug"]);
		expect(opts?.taskKind).toBe("review");
		expect(opts?.prompt).toBe("find the bug");
	});

	test("the value after --task-kind is not part of the prompt", () => {
		const opts = parseCLIArgs(["--cli", "--task-kind", "code", "write", "a", "debounce"]);
		expect(opts?.prompt).toBe("write a debounce");
	});

	test("omitting it builds the same request as before #3461", () => {
		const opts = parseCLIArgs(["--cli", "--model", "m1", "hello"])!;
		expect(opts.taskKind).toBeUndefined();
		expect(opts.taskKindError).toBeUndefined();
		const req = buildCLIChatRequest(opts);
		expect("taskKind" in req).toBe(false);
		expect(Object.keys(req)).toEqual(["messages", "model"]);
		expect(req.messages[1]).toEqual({ role: "user", content: "hello" });
		// With the flag on and no kind, the policy leaves the request alone.
		expect(applyEffortPolicy(req, ON)).toBe(req);
	});

	test("with the kind given but the flag unset, the policy changes nothing", () => {
		const req = buildCLIChatRequest(parseCLIArgs(["--cli", "--task-kind", "review", "x"])!);
		expect(applyEffortPolicy(req, {})).toBe(req);
		expect(applyEffortPolicy(req, { EIGHT_EFFORT_POLICY: "true" })).toBe(req);
	});

	test("an invalid or missing value is rejected, never passed on", () => {
		for (const args of [
			["--cli", "--task-kind", "security", "x"],
			["--cli", "--task-kind=creative", "x"],
			["--cli", "--task-kind=", "x"],
			["--cli", "x", "--task-kind"],
		]) {
			const opts = parseCLIArgs(args)!;
			expect(opts.taskKind).toBeUndefined();
			expect(opts.taskKindError).toContain("Invalid --task-kind");
			expect("taskKind" in buildCLIChatRequest(opts)).toBe(false);
		}
	});

	test("8gent --cli exits 1 on an invalid kind before calling any model", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-task-kind-"));
		try {
			const bin = path.join(import.meta.dir, "..", "..", "bin", "8gent.ts");
			const proc = Bun.spawnSync(
				[process.execPath, bin, "--cli", "--json", "--task-kind", "bogus", "hello"],
				{
					env: { ...process.env, HOME: home, TMPDIR: home, EIGHT_HOME: path.join(home, ".8gent") },
				},
			);
			expect(proc.exitCode).toBe(1);
			const out = JSON.parse(proc.stdout.toString().trim().split("\n").pop()!);
			expect(out.error).toContain("Invalid --task-kind");
			expect(out.exitCode).toBe(1);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});
});
