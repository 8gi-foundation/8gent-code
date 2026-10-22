import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyOverlay,
	dropOverlay,
	loadOverlay,
	mergeOverlay,
	overlayNotes,
	overlayPath,
	proposePromotion,
	validateOverlay,
	writeOverlay,
} from "./harness-overlay";
import { resolveHarnessProfile } from "./harness-profile";

const mk = (g: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
	task_id: "t1",
	created: "2026-10-22T00:00:00Z",
	expires_with: "task",
	guidance: {
		prompt_notes: ["read the test first"],
		tool_hints: { run_command: "pass --bail" },
		...g,
	},
	...extra,
});
const profile = () =>
	resolveHarnessProfile("qwen/qwen3.8-27b", { maxSteps: 30, maxOutputTokens: 8192 });
let dir: string;
const saved = { ...process.env };
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "overlay-"));
	process.env.EIGHT_HARNESS_DIR = dir;
});
afterEach(() => {
	process.env = { ...saved };
	rmSync(dir, { recursive: true, force: true });
});

describe("schema", () => {
	test("rejects permission-like keys at any depth", () => {
		for (const k of ["permission", "allow", "deny", "policy", "system_one", "sandbox"]) {
			expect(() => validateOverlay(mk({}, { [k]: 1 }))).toThrow();
			expect(() => validateOverlay(mk({ [k]: ["x"] }))).toThrow();
			expect(() => validateOverlay(mk({ tool_hints: { [k]: "x" } }))).toThrow();
		}
	});
	test("rejects unknown keys and bad shapes", () => {
		expect(() => validateOverlay(mk({}, { extra: 1 }))).toThrow();
		expect(() => validateOverlay(mk({ prompt_notes: "x" }))).toThrow();
		expect(() => validateOverlay({ ...mk(), task_id: "../x" })).toThrow();
		expect(validateOverlay(mk()).task_id).toBe("t1");
	});
});

describe("bounds and merge order", () => {
	test("cannot raise step_budget above the profile or push nudge later", () => {
		const m = mergeOverlay(profile(), validateOverlay(mk({ step_budget: 80, nudge: 0.9 })));
		expect(m.maxSteps).toBe(50);
		expect(m.nudgeFraction).toBe(0.6);
	});
	test("tightens inside the bounds, never below them", () => {
		expect(
			mergeOverlay(profile(), validateOverlay(mk({ step_budget: 35, nudge: 0.55 }))),
		).toMatchObject({ maxSteps: 35, nudgeFraction: 0.55 });
		expect(
			mergeOverlay(profile(), validateOverlay(mk({ step_budget: 1, nudge: 0.1 }))),
		).toMatchObject({ maxSteps: 20, nudgeFraction: 0.5 });
	});
	test("profile first, then overlay; permissions-free fields untouched", () => {
		const p = profile();
		const m = mergeOverlay(p, validateOverlay(mk({ step_budget: 40 })));
		expect(m.maxOutputTokens).toBe(p.maxOutputTokens);
		expect(m.source).toBe(p.source);
	});
});

describe("lifecycle and flag", () => {
	test("flag on applies and logs one line", () => {
		writeOverlay(mk({ step_budget: 40 }));
		const r = applyOverlay(profile(), "t1", { EIGHT_HARNESS_OVERLAY: "1" });
		expect(r.profile.maxSteps).toBe(40);
		expect(r.line).toBe("[harness] overlay t1 applied: 1 notes, 1 hints");
		process.env.EIGHT_HARNESS_OVERLAY = "1";
		process.env.EIGHT_TASK_ID = "t1";
		expect(overlayNotes()).toContain("read the test first");
	});
	test("flag off is a no-op", () => {
		writeOverlay(mk({ step_budget: 40 }));
		const p = profile();
		const r = applyOverlay(p, "t1", {});
		expect(r).toEqual({ profile: p, overlay: null, line: null });
		process.env.EIGHT_TASK_ID = "t1";
		expect(overlayNotes()).toBe("");
	});
	test("expiry deletes the file", () => {
		const path = writeOverlay(mk());
		expect(existsSync(path)).toBe(true);
		expect(dropOverlay("t1")).toBe(true);
		expect(existsSync(overlayPath("t1"))).toBe(false);
		expect(loadOverlay("t1")).toBeNull();
		expect(dropOverlay("t1")).toBe(false);
	});
	test("promotion writes a proposal and never edits the profile table", () => {
		writeOverlay(mk());
		const path = proposePromotion("t1", "failed twice on the same test");
		expect(path).toContain("proposals");
		expect(existsSync(path)).toBe(true);
	});
});
