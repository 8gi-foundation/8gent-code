/**
 * The DONE block and the PLAN column describe one plan, so they must count
 * the same steps. Pilot run 2026-09-30 052339 (l3-bugfix-m5) showed the PLAN
 * column at "5 of 5 done" while the DONE block listed the 5 steps and then
 * "3 more steps": three folded tool calls, read as three more plan steps.
 *
 * Both surfaces are rendered through Ink from one plan state, the way the
 * app holds it: the PLAN column's steps, stamped on the reply (Message.plan).
 */

import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import type { Message } from "../../app.js";
import { planStepsFromText } from "../../lib/activity-rail-derivation.js";
import { type PlanStep, mergePlanText, replyPlan, settlePlan } from "../../lib/plan-state.js";
import type { ToolTrailEntry } from "../../lib/tool-trail.js";
import { PlanPanel } from "../PlanPanel.js";
import { MessageList } from "../message-list.js";

const at = new Date("2026-09-30T05:29:00Z");

const toolEnd = (id: string, entry: ToolTrailEntry): Message => ({
	id: `tool-end-${id}`,
	role: "tool",
	content: "  ✓",
	timestamp: at,
	toolTrail: entry,
});

const planColumn: PlanStep[] = settlePlan(
	[
		"Explore the project structure",
		"Inspect failing test and source to locate bug",
		"Fix the bug in source code",
		"Re-run bun test until all pass",
		"Summarise root cause",
	].map((text, i) => ({ id: `s${i}`, text, status: "done" as const })),
);

function turn(plan: PlanStep[] | undefined, calls: ToolTrailEntry[]): Message[] {
	return [
		{
			id: "u1",
			role: "user",
			content: "The tests in this package fail. Fix the bug.",
			timestamp: at,
		},
		...calls.map((c, i) => toolEnd(String(i), c)),
		{
			id: "a1",
			role: "assistant",
			content: "All 7 tests pass.",
			timestamp: at,
			...(plan ? { plan } : {}),
		},
	];
}

const pilotCalls: ToolTrailEntry[] = [
	{ tool: "list_files", summary: ".", status: "ok" },
	{ tool: "read_file", summary: "src/paginate.test.ts", status: "ok" },
	{ tool: "run_command", summary: "bun test", status: "ok" },
	{ tool: "read_file", summary: "src/paginate.ts", status: "ok" },
	{ tool: "edit_file", summary: "src/paginate.ts", status: "ok" },
	{ tool: "run_command", summary: "bun test 2>&1 | tail -30", status: "ok" },
];

function doneBlock(messages: Message[], rowBudget = 16): string {
	return renderToString(
		<MessageList
			messages={messages}
			animateTyping={false}
			showAnimations={false}
			scrollEnabled={false}
			contentWidth={72}
			rowBudget={rowBudget}
		/>,
		{ columns: 80 },
	);
}

/** Plan steps the DONE block stands for: step rows drawn plus "N more steps". */
function stepsInDone(out: string, plan: PlanStep[]): number {
	const drawn = plan.filter((s) => out.includes(s.text.split(/\s+/).slice(1, 3).join(" "))).length;
	const folded = [...out.matchAll(/(\d+) more steps?\b/g)].reduce((n, m) => n + Number(m[1]), 0);
	return drawn + folded;
}

/** The PLAN column's total, from its own summary line. */
function stepsInColumn(plan: PlanStep[]): number {
	const out = renderToString(
		<PlanPanel steps={plan} running={false} width={28} animate={false} />,
		{
			columns: 28,
		},
	);
	const m = /(\d+) of (\d+) done|(\d+) steps? planned/.exec(out);
	if (!m) throw new Error(`no summary in:\n${out}`);
	return Number(m[2] ?? m[3]);
}

describe("the DONE block and the PLAN column count the same steps", () => {
	test("the pilot turn: 5 of 5, and the folded calls are actions", () => {
		const out = doneBlock(turn(planColumn, pilotCalls), 16);
		expect(stepsInColumn(planColumn)).toBe(5);
		expect(stepsInDone(out, planColumn)).toBe(5);
		expect(out).not.toMatch(/more steps?\b/);
	});

	test("in a short window the plan folds too, and the sum still holds", () => {
		for (const budget of [8, 10, 12, 14]) {
			const out = doneBlock(turn(planColumn, pilotCalls), budget);
			expect({ budget, steps: stepsInDone(out, planColumn) }).toEqual({ budget, steps: 5 });
		}
	});

	test("a plan the column took from PLAN: text shows in the DONE block too", () => {
		const written = settlePlan(
			mergePlanText([], ["Read the failing test", "Fix the slice start", "Run bun test again"]),
		);
		const out = doneBlock(turn(written, pilotCalls.slice(4)), 20);
		expect(stepsInColumn(written)).toBe(3);
		expect(stepsInDone(out, written)).toBe(3);
	});

	test("a turn that wrote a plan and called nothing still gets its DONE block (#3096)", () => {
		const reply =
			"PLAN:\n1. Read the failing test\n2. Fix the slice start\n3. Run bun test again\n\nShall I go ahead?";
		// The column has not caught up yet: the stamp takes the reply's own lines.
		const stamped = replyPlan([], planStepsFromText(reply));
		const messages: Message[] = [
			{
				id: "u1",
				role: "user",
				content: "Plan the fix first, do not change anything.",
				timestamp: at,
			},
			{ id: "a1", role: "assistant", content: reply, timestamp: at, plan: stamped },
		];
		const out = doneBlock(messages, 20);
		expect(stepsInColumn(stamped)).toBe(3);
		expect(stepsInDone(out, stamped)).toBe(3);
		// The steps are rows of the block, with the pending mark, not only
		// the numbered list inside the reply.
		for (const step of ["Read the failing test", "Fix the slice start", "Run bun test again"]) {
			expect(out).toMatch(new RegExp(`[○o] ${step}`));
		}
		// Nothing ran, so nothing is ticked and no action rows are invented.
		expect(out).not.toContain("✓");
		expect(out).not.toMatch(/more actions?\b/);
		expect(out).not.toContain("No reply.");
	});

	test("a plain reply with no plan and no calls has no DONE block", () => {
		const out = doneBlock(
			[
				{ id: "u1", role: "user", content: "hi", timestamp: at },
				{ id: "a1", role: "assistant", content: "Good day.", timestamp: at },
			],
			20,
		);
		expect(out).not.toMatch(/[✓○✗]/);
	});
});
