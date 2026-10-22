import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_OVERLAY_AGE_MS,
	applyOverlay,
	dropOverlay,
	loadLiveOverlay,
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
	session_id: "s1",
	created: new Date().toISOString(),
	expires_with: "task",
	guidance: {
		prompt_notes: ["read the test first"],
		tool_hints: { run_command: "pass --bail" },
		...g,
	},
	...extra,
});
const PLACEHOLDER_MODEL = "placeholder/not-a-real-model";
const profile = () =>
	resolveHarnessProfile(
		PLACEHOLDER_MODEL,
		{ maxSteps: 30, maxOutputTokens: 8192 },
		{ [PLACEHOLDER_MODEL]: { maxSteps: 50, nudgeFraction: 0.6, why: "test fixture" } },
	);
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
		const r = applyOverlay(profile(), { EIGHT_HARNESS_OVERLAY: "1", EIGHT_TASK_ID: "t1" }, "s1");
		expect(r.profile.maxSteps).toBe(40);
		expect(r.line).toBe("[harness] overlay t1 applied: 1 notes, 1 hints");
		process.env.EIGHT_HARNESS_OVERLAY = "1";
		process.env.EIGHT_TASK_ID = "t1";
		expect(overlayNotes(process.env, "s1")).toContain("read the test first");
	});
	test("flag off is a no-op", () => {
		writeOverlay(mk({ step_budget: 40 }));
		const p = profile();
		const r = applyOverlay(p, {}, "s1");
		expect(r).toEqual({ profile: p, overlay: null, line: null });
		process.env.EIGHT_TASK_ID = "t1";
		expect(overlayNotes(process.env, "s1")).toBe("");
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

describe("expiry is enforced at load (one gate)", () => {
	const env = { EIGHT_HARNESS_OVERLAY: "1", EIGHT_TASK_ID: "t1" };
	test("live overlay for this task and session loads and stays", () => {
		writeOverlay(mk());
		expect(loadLiveOverlay(env, "s1")?.task_id).toBe("t1");
		expect(existsSync(overlayPath("t1"))).toBe(true);
	});
	test("a different current task id ignores and deletes it", () => {
		const path = writeOverlay(mk());
		expect(loadLiveOverlay({ ...env, EIGHT_TASK_ID: "t2" }, "s1")).toBeNull();
		// the file for t1 is only reachable by its own id: reading it as t1 with a renamed task id inside is the mismatch case
		expect(existsSync(path)).toBe(true);
		const renamed = { ...mk(), task_id: "other" };
		writeOverlay(renamed);
		expect(loadLiveOverlay({ ...env, EIGHT_TASK_ID: "other" }, "s1")?.task_id).toBe("other");
	});
	test("a file whose task id does not match its name is ignored and deleted", () => {
		const path = writeOverlay(mk());
		const { writeFileSync, readFileSync } = require("node:fs");
		const raw = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify({ ...raw, task_id: "t9" }));
		expect(loadLiveOverlay(env, "s1")).toBeNull();
		expect(existsSync(path)).toBe(false);
	});
	test("another session ignores and deletes it", () => {
		const path = writeOverlay(mk());
		expect(loadLiveOverlay(env, "s2")).toBeNull();
		expect(existsSync(path)).toBe(false);
	});
	test("an unknown current session fails closed", () => {
		const path = writeOverlay(mk());
		expect(loadLiveOverlay(env, undefined)).toBeNull();
		expect(existsSync(path)).toBe(false);
	});
	test("older than the bound ignores and deletes it; just inside keeps it", () => {
		const created = new Date(Date.now() - MAX_OVERLAY_AGE_MS - 1000).toISOString();
		const path = writeOverlay(mk({}, { created }));
		expect(loadLiveOverlay(env, "s1")).toBeNull();
		expect(existsSync(path)).toBe(false);
		const fresh = new Date(Date.now() - MAX_OVERLAY_AGE_MS + 60_000).toISOString();
		writeOverlay(mk({}, { created: fresh }));
		expect(loadLiveOverlay(env, "s1")).not.toBeNull();
	});
	test("applyOverlay and overlayNotes both go through the gate", () => {
		writeOverlay(mk());
		expect(applyOverlay(profile(), env, "s2").overlay).toBeNull();
		writeOverlay(mk());
		expect(overlayNotes(env, "s2")).toBe("");
		expect(existsSync(overlayPath("t1"))).toBe(false);
	});
});

describe("injection source", () => {
	test("writeOverlay refuses when the tool-shell mark is set, even if empty", () => {
		expect(() => writeOverlay(mk(), { EIGHT_PARENT_SESSION: "123" })).toThrow(/tool shell/);
		expect(() => writeOverlay(mk(), { EIGHT_PARENT_SESSION: "" })).toThrow(/tool shell/);
		expect(existsSync(overlayPath("t1"))).toBe(false);
		expect(existsSync(writeOverlay(mk(), {}))).toBe(true);
	});
});

describe("size caps", () => {
	const hints = (n: number) =>
		Object.fromEntries(Array.from({ length: n }, (_, i) => [`tool${i}`, "h"]));
	test("tool_hints entry count is capped at 8", () => {
		expect(() => validateOverlay(mk({ tool_hints: hints(8) }))).not.toThrow();
		expect(() => validateOverlay(mk({ tool_hints: hints(9) }))).toThrow(/at most 8/);
	});
	test("tool_hints key length is capped at 64", () => {
		expect(() => validateOverlay(mk({ tool_hints: { ["k".repeat(64)]: "h" } }))).not.toThrow();
		expect(() => validateOverlay(mk({ tool_hints: { ["k".repeat(65)]: "h" } }))).toThrow(/keys/);
	});
	test("tool_hints value length is capped at 400", () => {
		expect(() => validateOverlay(mk({ tool_hints: { a: "v".repeat(400) } }))).not.toThrow();
		expect(() => validateOverlay(mk({ tool_hints: { a: "v".repeat(401) } }))).toThrow();
	});
	test("session_id is required", () => {
		const { session_id, ...rest } = mk() as Record<string, unknown>;
		expect(() => validateOverlay(rest)).toThrow(/session_id/);
	});
});
