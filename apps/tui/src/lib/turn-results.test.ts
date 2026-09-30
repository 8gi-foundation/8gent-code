/**
 * Turn results: a finished turn's calls and reported plan as checked steps.
 * Every entry here is a real trail shape (lib/tool-trail.ts toTrailEntry) and
 * every plan is a real update_plan argument shape (packages/eight/tools.ts).
 */

import { describe, expect, test } from "bun:test";
import { type ToolTrailEntry, toTrailEntry } from "./tool-trail";
import { MAX_RESULT_ROWS, buildTurnResults, fitResultRow, turnPlan } from "./turn-results";

const ok = (tool: string, summary: string): ToolTrailEntry => ({ tool, summary, status: "ok" });

describe("buildTurnResults: tool rows", () => {
	test("a bold verb and the path or command, from the tool name", () => {
		const rows = buildTurnResults([
			ok("write_file", "deck/outline.md"),
			ok("edit_file", "src/paginate.ts"),
			ok("run_command", "bun test"),
		]);
		expect(rows.map((r) => [r.verb, r.chip])).toEqual([
			["Wrote", "deck/outline.md"],
			["Edited", "src/paginate.ts"],
			["Ran", "bun test"],
		]);
		expect(rows.every((r) => r.status === "ok")).toBe(true);
	});

	test("a command that exited non-zero ran, and says its exit code", () => {
		const [row] = buildTurnResults([{ tool: "run_command", summary: "bun test", status: "fail", reason: "exit 1" }]);
		expect(row).toMatchObject({ status: "fail", verb: "Ran", chip: "bun test", note: "exit 1" });
	});

	test("any other failure never claims the work happened", () => {
		const [row] = buildTurnResults([
			{ tool: "write_file", summary: "deck/outline.md", status: "fail", reason: "Unterminated string" },
		]);
		expect(row).toMatchObject({ status: "fail", verb: "Write failed", note: "Unterminated string" });
	});

	test("a blocked call names what was stopped and the rule", () => {
		const [row] = buildTurnResults([
			{ tool: "write_file", summary: ".env", status: "blocked", reason: "blocked: [no-secrets-in-files]" },
		]);
		expect(row).toMatchObject({ status: "blocked", verb: "Write blocked", chip: ".env", note: "[no-secrets-in-files]" });
	});

	test("an unknown tool shows its own name, never an invented verb", () => {
		const [row] = buildTurnResults([ok("vercel_deploy", "site")]);
		expect(row.verb).toBe("vercel_deploy");
	});

	test("consecutive reads fold into one row with the shared folder", () => {
		const rows = buildTurnResults([
			ok("read_file", "packages/decide/README.md"),
			ok("read_file", "packages/decide/index.ts"),
			ok("read_file", "packages/decide/docs/ENGINE.md"),
			ok("write_file", "deck/outline.md"),
		]);
		expect(rows[0]).toMatchObject({ verb: "Read", chip: "packages/decide/", note: "3 files", count: 3 });
		expect(rows[1]).toMatchObject({ verb: "Wrote", chip: "deck/outline.md" });
	});

	test("the same file written twice is one row with a count", () => {
		const rows = buildTurnResults([
			ok("edit_file", "src/paginate.ts"),
			ok("run_command", "bun test"),
			ok("edit_file", "src/paginate.ts"),
		]);
		expect(rows.map((r) => [r.verb, r.note])).toEqual([
			["Edited", "×2"],
			["Ran", undefined],
		]);
	});

	test("a failed run and the passing rerun both stay: that is the story", () => {
		const rows = buildTurnResults([
			{ tool: "run_command", summary: "bun test", status: "fail", reason: "exit 1" },
			ok("edit_file", "src/paginate.ts"),
			ok("run_command", "bun test"),
		]);
		expect(rows.map((r) => [r.status, r.verb])).toEqual([
			["fail", "Ran"],
			["ok", "Edited"],
			["ok", "Ran"],
		]);
	});

	test("update_plan is bookkeeping, not a result row", () => {
		const rows = buildTurnResults([ok("update_plan", ""), ok("write_file", "a.md")]);
		expect(rows.map((r) => r.verb)).toEqual(["Wrote"]);
	});

	test("no calls, no rows", () => {
		expect(buildTurnResults([])).toEqual([]);
	});
});

describe("buildTurnResults: the reported plan", () => {
	const plan = (steps: Array<[string, string]>) =>
		toTrailEntry({
			toolName: "update_plan",
			args: { plan: steps.map(([step, status]) => ({ step, status })) },
			success: true,
			resultPreview: "Plan updated",
		});

	test("toTrailEntry keeps update_plan's steps on the trail entry", () => {
		const e = plan([["Read the failing test", "completed"]]);
		expect(e.plan).toEqual([{ step: "Read the failing test", status: "completed" }]);
	});

	test("plan steps lead, in the agent's words, first word bold", () => {
		const rows = buildTurnResults([
			plan([
				["Find the off-by-one", "completed"],
				["Fix paginate", "completed"],
			]),
			ok("edit_file", "src/paginate.ts"),
		]);
		expect(rows[0]).toMatchObject({ kind: "plan", status: "ok", verb: "Find", text: "the off-by-one" });
		expect(rows[1]).toMatchObject({ kind: "plan", status: "ok", verb: "Fix", text: "paginate" });
		expect(rows[2]).toMatchObject({ kind: "tool", verb: "Edited" });
	});

	test("the last update_plan wins; a step left in progress is not ticked", () => {
		const steps = turnPlan([
			plan([["Fix paginate", "pending"]]),
			plan([
				["Fix paginate", "in_progress"],
				["Run the tests", "failed"],
			]),
		]);
		expect(steps.map((s) => s.status)).toEqual(["pending", "failed"]);
		const rows = buildTurnResults([
			plan([
				["Fix paginate", "in_progress"],
				["Run the tests", "failed"],
			]),
		]);
		expect(rows.map((r) => r.status)).toEqual(["pending", "fail"]);
	});

	test("a failed update_plan call is ignored", () => {
		const e = { ...plan([["Fix", "completed"]]), status: "fail" as const };
		expect(turnPlan([e])).toEqual([]);
	});
});

describe("buildTurnResults: a long turn folds", () => {
	test("the oldest successes fold first; failures and blocks stay", () => {
		const trail: ToolTrailEntry[] = [
			...Array.from({ length: 12 }, (_, i) => ok("write_file", `notes/f${i}.txt`)),
			{ tool: "run_command", summary: "ls notes", status: "blocked", reason: "blocked" },
		];
		const rows = buildTurnResults(trail, 5);
		expect(rows).toHaveLength(5);
		expect(rows[0]).toMatchObject({ kind: "fold", verb: "9 more steps" });
		expect(rows.at(-1)).toMatchObject({ status: "blocked", verb: "Run blocked" });
	});

	test("the default ceiling holds", () => {
		const trail = Array.from({ length: 40 }, (_, i) => ok("write_file", `f${i}.txt`));
		expect(buildTurnResults(trail).length).toBe(MAX_RESULT_ROWS);
	});
});

describe("fitResultRow", () => {
	test("the chip is cut before the verb, and the whole row fits", () => {
		const row = { kind: "tool" as const, status: "ok" as const, verb: "Ran", chip: "x".repeat(200), count: 1, note: "exit 1" };
		const fit = fitResultRow(row, 40);
		const used = 2 + fit.verb.length + (fit.chip ? fit.chip.length + 3 : 0) + (fit.note ? fit.note.length + (fit.noteGap ?? 0) : 0);
		expect(fit.verb).toBe("Ran");
		expect(fit.chip?.endsWith("…")).toBe(true);
		expect(fit.note).toBe("exit 1");
		expect(used).toBeLessThanOrEqual(40);
	});

	test("a very narrow column keeps the verb", () => {
		const fit = fitResultRow({ kind: "tool", status: "ok", verb: "Wrote", chip: "deck/outline.md", count: 1 }, 10);
		expect(fit.verb).toBe("Wrote");
	});
});
