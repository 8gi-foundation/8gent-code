/**
 * #4161: a checklist plan file in the project is the plan of record.
 *
 * Pilot run 2026-10-13_074318 (approve-go-ahead-practice): PLAN.md had three
 * open boxes, the model called update_plan with every step "done", got
 * "Plan updated: 5 of 5 done", never ticked PLAN.md, and the judge failed
 * plan_steps_ticked. PLAN below is that fixture's plan, and DONE_CALL is the
 * model's own last update_plan call from that run (tool call tt-25).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	findPlanFile,
	matchBox,
	namedPlanFiles,
	notePlanTask,
	parseCheckboxes,
} from "../ai/plan-file";
import { agentTools, getToolContext, setToolContext } from "../ai/tools";
import { updatePlan } from "../ai/update-plan";
import { ToolExecutor } from "./tools";

const PLAN = `# Plan: slugify helper

Status: awaiting approval from James

Steps (do them in order, tick each box when it is done):

- [ ] 1. Add \`src/slugify.ts\` exporting \`slugify(input: string): string\`: lower-case, runs of anything that is not a letter or digit become one hyphen, no leading or trailing hyphen. Add at least one test for it under \`test/\`.
- [ ] 2. Update the \`Usage:\` line in README.md so it also shows \`slugify\` imported from \`./src/slugify\`. Leave every other line of README.md alone.
- [ ] 3. Bump \`version\` in package.json from 1.0.0 to 1.1.0. Change nothing else in that file.

Rules for this job:
- Keep Dana updated in STATUS.md. One line per step as it is finished.
`;

const DONE_CALL = {
	plan: [
		{ status: "done", step: "Add src/slugify.ts + test under test/" },
		{ status: "done", step: "Update README.md Usage line for slugify" },
		{ status: "done", step: "Bump package.json version to 1.1.0" },
		{ status: "done", step: "Keep Dana updated in STATUS.md per step" },
		{ status: "done", step: "Verify tests pass and leave changes uncommitted" },
	],
};

const OF_RECORD = "the plan of record is PLAN.md; tick its boxes with edit_file";

const tick = (plan: string, n: number) => plan.replace(`- [ ] ${n}.`, `- [x] ${n}.`);

let root: string;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-file-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("update_plan with a checklist plan file (#4161)", () => {
	test("the pilot's all-done call is refused while PLAN.md's boxes are open, and names the file", () => {
		fs.writeFileSync(path.join(root, "PLAN.md"), PLAN);
		const out = updatePlan(DONE_CALL, root);
		expect(out).toStartWith("Error: update_plan:");
		expect(out).toContain(OF_RECORD);
		expect(out).toContain("(0 of 3 ticked)");
		expect(out).toContain('"Add src/slugify.ts + test under test/" (PLAN.md item 1)');
		expect(out).toContain('"Update README.md Usage line for slugify" (PLAN.md item 2)');
		expect(out).toContain('"Bump package.json version to 1.1.0" (PLAN.md item 3)');
		// Steps that are not in the file are never refused.
		expect(out).not.toContain("Keep Dana");
		expect(out).not.toContain("Verify tests");
	});

	test("one open box is enough to refuse; the ticked ones are not named", () => {
		fs.writeFileSync(path.join(root, "PLAN.md"), tick(tick(PLAN, 1), 3));
		const out = updatePlan(DONE_CALL, root);
		expect(out).toStartWith("Error: update_plan:");
		expect(out).toContain("(2 of 3 ticked)");
		expect(out).toContain("PLAN.md item 2");
		expect(out).not.toContain("PLAN.md item 1");
		expect(out).not.toContain("PLAN.md item 3");
	});

	test("with every box ticked the done call goes through, and the result names the file", () => {
		fs.writeFileSync(path.join(root, "PLAN.md"), tick(tick(tick(PLAN, 1), 2), 3));
		expect(updatePlan(DONE_CALL, root)).toBe(
			`Plan updated: 5 of 5 done. Note: ${OF_RECORD} (3 of 3 ticked)`,
		);
	});

	test("progress short of done is never refused, and still points at the file", () => {
		fs.writeFileSync(path.join(root, "PLAN.md"), PLAN);
		const out = updatePlan(
			{
				plan: [
					{ step: "Add src/slugify.ts + test under test/", status: "in_progress" },
					{ step: "Update README.md Usage line for slugify", status: "pending" },
				],
			},
			root,
		);
		expect(out).toBe(
			`Plan updated: 0 of 2 done. Current: Add src/slugify.ts + test under test/. Note: ${OF_RECORD} (0 of 3 ticked)`,
		);
	});

	test("a step that names its number matches the numbered box", () => {
		fs.writeFileSync(path.join(root, "PLAN.md"), tick(PLAN, 1));
		expect(updatePlan({ plan: [{ step: "Step 2: the readme", status: "done" }] }, root)).toContain(
			"PLAN.md item 2",
		);
		expect(updatePlan({ plan: [{ step: "1. slugify", status: "done" }] }, root)).toStartWith(
			"Plan updated: 1 of 1 done",
		);
	});

	test("with no plan file update_plan answers exactly as before", () => {
		fs.writeFileSync(path.join(root, "NOTES.md"), "- [ ] not a plan file name\n");
		fs.writeFileSync(path.join(root, "PLAN.md"), "# Plan\n\nNo checkboxes here.\n");
		const before = updatePlan(DONE_CALL);
		expect(before).toBe("Plan updated: 5 of 5 done");
		expect(updatePlan(DONE_CALL, root)).toBe(before);
	});

	test("both tool paths pass their working directory", async () => {
		fs.writeFileSync(path.join(root, "PLAN.md"), PLAN);
		expect(await new ToolExecutor(root).execute("update_plan", DONE_CALL)).toContain(OF_RECORD);

		const saved = getToolContext();
		setToolContext({ workingDirectory: root });
		try {
			const out = await agentTools.update_plan.execute?.(
				DONE_CALL as Parameters<NonNullable<typeof agentTools.update_plan.execute>>[0],
				{ toolCallId: "t", messages: [] },
			);
			expect(out).toStartWith("Error: update_plan:");
			expect(out).toContain(OF_RECORD);
		} finally {
			setToolContext(saved);
		}
	});
});

describe("finding the plan file", () => {
	test("a file the task names is found, inside the working directory only", () => {
		fs.mkdirSync(path.join(root, "docs"));
		fs.writeFileSync(path.join(root, "docs", "rollout.md"), "- [x] a\n- [ ] b\n");
		expect(findPlanFile(root)).toBeNull();
		expect(findPlanFile(root, "Go ahead with docs/rollout.md please.")?.name).toBe(
			"docs/rollout.md",
		);

		notePlanTask(root, "Carry out `docs/rollout.md`.");
		expect(findPlanFile(root)?.name).toBe("docs/rollout.md");
		notePlanTask(root, "");

		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "plan-outside-"));
		try {
			fs.writeFileSync(path.join(outside, "steps.md"), "- [ ] escape\n");
			const rel = path.relative(root, path.join(outside, "steps.md"));
			expect(findPlanFile(root, `Follow ${rel}`)).toBeNull();
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	test("README and CHANGELOG checklists are documentation, not a plan", () => {
		expect(namedPlanFiles("update README.md and CHANGELOG.md, then follow TASKS.md")).toEqual([
			"TASKS.md",
		]);
	});

	test("parses ticked, open and numbered boxes, and nothing else", () => {
		const boxes = parseCheckboxes(
			"- [x] 1. One\n* [ ] Two\n  + [X] 3) Three\n- not a box\n- [] nope\n",
		);
		expect(boxes).toEqual([
			{ checked: true, text: "One", number: 1 },
			{ checked: false, text: "Two" },
			{ checked: true, text: "Three", number: 3 },
		]);
	});

	test("matching needs most of the step's words, so loose steps match nothing", () => {
		const boxes = parseCheckboxes(PLAN);
		expect(matchBox("Bump package.json version to 1.1.0", boxes)?.number).toBe(3);
		expect(matchBox("Run the tests", boxes)).toBeUndefined();
		expect(matchBox("slugify", boxes)).toBeUndefined();
	});
});
