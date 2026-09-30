/**
 * Turn results: a finished turn's calls and reported plan as checked steps.
 * Every entry here is a real trail shape (lib/tool-trail.ts toTrailEntry) and
 * every plan is a real update_plan argument shape (packages/eight/tools.ts).
 */

import { describe, expect, test } from "bun:test";
import { type PlanStep, applyPlanUpdate, mergePlanText, settlePlan } from "./plan-state";
import { type ToolTrailEntry, toTrailEntry } from "./tool-trail";
import {
	MAX_RESULT_ROWS,
	buildTurnResults,
	fitResultRow,
	stepsShown,
	turnPlan,
} from "./turn-results";

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
		expect(rows[0]).toMatchObject({ kind: "fold", verb: "9 more actions" });
		expect(rows.at(-1)).toMatchObject({ status: "blocked", verb: "Run blocked" });
	});

	test("the default ceiling holds", () => {
		const trail = Array.from({ length: 40 }, (_, i) => ok("write_file", `f${i}.txt`));
		expect(buildTurnResults(trail).length).toBe(MAX_RESULT_ROWS);
	});
});

describe("buildTurnResults: the step count is the PLAN column's", () => {
	const statuses = ["done", "pending", "failed"] as const;
	const planOf = (n: number, seed = 0): PlanStep[] =>
		Array.from({ length: n }, (_, i) => ({
			id: `s${i}`,
			text: `Step ${i + 1} of the plan`,
			status: statuses[(i + seed) % statuses.length],
		}));
	const callsOf = (n: number): ToolTrailEntry[] =>
		Array.from({ length: n }, (_, i) =>
			i % 5 === 4
				? { tool: "run_command", summary: `cmd ${i}`, status: "fail", reason: "exit 1" }
				: ok("write_file", `f${i}.txt`),
		);

	test("the pilot turn: 5 of 5 done and 3 folded calls read as actions, not steps", () => {
		// Run 2026-09-30 052339: PLAN 5/5, then "✓ 3 more steps" under the plan.
		const plan = planOf(5).map((s) => ({ ...s, status: "done" as const }));
		const trail = [
			ok("list_files", "."),
			ok("read_file", "src/paginate.test.ts"),
			ok("run_command", "bun test"),
			ok("read_file", "src/paginate.ts"),
			ok("edit_file", "src/paginate.ts"),
			ok("run_command", "bun test 2>&1 | tail -30"),
		];
		const rows = buildTurnResults(trail, 9, plan);
		expect(rows).toHaveLength(9);
		expect(stepsShown(rows)).toBe(5);
		const fold = rows.find((r) => r.kind === "fold");
		expect(fold?.verb).toMatch(/^\d+ more actions?$/);
		expect(rows.some((r) => /more steps?/.test(r.verb))).toBe(false);
	});

	test("every plan length, call count and window: steps shown = plan length, rows fit", () => {
		for (let n = 0; n <= 8; n++) {
			for (let calls = 0; calls <= 14; calls++) {
				for (let cap = 1; cap <= 12; cap++) {
					const plan = planOf(n, calls);
					const rows = buildTurnResults(callsOf(calls), cap, plan);
					const where = `plan ${n}, calls ${calls}, cap ${cap}`;
					expect({ where, steps: stepsShown(rows) }).toEqual({ where, steps: n });
					expect({ where, fits: rows.length <= cap }).toEqual({ where, fits: true });
					for (const r of rows) {
						if (r.kind !== "fold") continue;
						// "N more steps" names exactly the plan steps folded into it.
						const m = /^(\d+) more steps?$/.exec(r.verb);
						if (m) expect(Number(m[1])).toBe(r.steps ?? -1);
						else expect(r.steps ?? 0).toBe(0);
					}
				}
			}
		}
	});

	test("a folded run of pending steps is not ticked", () => {
		const plan = planOf(6).map((s, i) => ({ ...s, status: i === 0 ? ("done" as const) : ("pending" as const) }));
		const rows = buildTurnResults([], 3, plan);
		const fold = rows.find((r) => r.kind === "fold");
		expect(fold).toMatchObject({ status: "pending", verb: "4 more steps" });
		expect(stepsShown(rows)).toBe(6);
	});

	test("a plan written as PLAN: text, never reported by update_plan, still shows", () => {
		// The PLAN column merges written plan text; the trail has no update_plan.
		const column = settlePlan(mergePlanText([], ["Read the failing test", "Fix the slice", "Run bun test"]));
		const trail = [ok("edit_file", "src/paginate.ts"), ok("run_command", "bun test")];
		expect(turnPlan(trail)).toEqual([]);
		const rows = buildTurnResults(trail, MAX_RESULT_ROWS, column);
		expect(rows.slice(0, 3).map((r) => [r.kind, r.status, r.verb])).toEqual([
			["plan", "pending", "Read"],
			["plan", "pending", "Fix"],
			["plan", "pending", "Run"],
		]);
		expect(stepsShown(rows)).toBe(column.length);
	});

	test("the column's own reducer and the trail agree when update_plan is the source", () => {
		const reports = [
			[{ step: "Find the bug", status: "in_progress" }, { step: "Fix it", status: "pending" }],
			[{ step: "Find the bug", status: "completed" }, { step: "Fix it", status: "in_progress" }],
		];
		const column = settlePlan(reports.reduce<PlanStep[]>((prev, items) => applyPlanUpdate(prev, items), []));
		const trail = reports.map((items) => ({ tool: "update_plan", status: "ok" as const, plan: items }));
		const fromColumn = buildTurnResults(trail as ToolTrailEntry[], MAX_RESULT_ROWS, column);
		const fromTrail = buildTurnResults(trail as ToolTrailEntry[]);
		expect(fromColumn).toEqual(fromTrail);
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
