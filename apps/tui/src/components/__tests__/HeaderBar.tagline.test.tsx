/**
 * The brand tagline is the last thing the header keeps.
 *
 * "The Infinite Gentleman" is 25 columns of brand in a row whose job is to
 * say where you are working. It stays only while the workspace path, the
 * branch and the sync note all show whole beside it. The moment one of them
 * would be cut or dropped, the tagline steps aside first. It also leaves the
 * living 8 its columns: widening a pane never swaps the 8 for the brand line.
 */

import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { renderToString } from "ink";
import React from "react";
import { HeaderBar, type HeaderBarProps, planHeader } from "../HeaderBar";

// The shape of the 13 Nov frame: a home-directory repo, a docs branch that
// was never pushed, a wide pane.
const frame: HeaderBarProps = {
	updateAvailable: null,
	version: "0.20.45",
	workspacePath: "/Users/operator/8gi-governance",
	branch: "docs/software-factory-notes",
	syncStatus: "no upstream",
	micOn: false,
	approvalPending: false,
	mark: false,
};

function row(props: HeaderBarProps): string {
	const out = renderToString(<HeaderBar {...props} />, { columns: props.width ?? 80 });
	return stripVTControlCharacters(out).split("\n")[1] ?? "";
}

describe("HeaderBar tagline", () => {
	test("a wide header with room for everything keeps the tagline", () => {
		const props = { ...frame, width: 160 };
		const plan = planHeader(props);
		expect(plan.compactBrand).toBe(false);
		expect(plan.middle.path).toBe(frame.workspacePath);
		expect(row(props)).toContain("The Infinite Gentleman");
	});

	test("the tagline goes before the path is shortened", () => {
		// 120 columns: with the tagline the path was cut to make room for it.
		const props = { ...frame, width: 120 };
		const plan = planHeader(props);
		expect(plan.middle.path).toBe(frame.workspacePath);
		expect(plan.middle.branch).toBe(frame.branch);
		expect(plan.middle.sync).toBe("no upstream");
		expect(plan.compactBrand).toBe(true);
		const line = row(props);
		expect(line).toContain(frame.workspacePath);
		expect(line).not.toContain("Infinite Gentleman");
		expect(line).not.toContain("…");
	});

	test("the tagline goes before the sync note is dropped", () => {
		const props = { ...frame, workspacePath: "/Users/operator/work/8gi-governance", width: 110 };
		const plan = planHeader(props);
		expect(plan.middle.sync).toBe("no upstream");
		expect(plan.compactBrand).toBe(true);
	});

	test("a chip that takes the room takes it from the tagline, not the path", () => {
		const quiet = { ...frame, width: 130 };
		expect(planHeader(quiet).compactBrand).toBe(false);
		const asking = { ...quiet, approvalPending: true, micOn: true };
		const plan = planHeader(asking);
		expect(plan.compactBrand).toBe(true);
		expect(plan.middle.path).toBe(frame.workspacePath);
	});

	test("the tagline never costs the living 8 its place", () => {
		let both = 0;
		for (let width = 100; width <= 240; width++) {
			for (const chips of [{}, { approvalPending: true }, { approvalPending: true, micOn: true }]) {
				const plan = planHeader({ ...frame, ...chips, mark: true, width });
				if (!plan.compactBrand) {
					expect(plan.mark).toBe(true);
					both++;
				}
			}
		}
		expect(both).toBeGreaterThan(0);
	});

	test("outside a repo the same rule holds for the path and the note", () => {
		const props = {
			...frame,
			workspacePath: "/Users/operator/Documents/scratch/notes-for-the-week",
			branch: "",
			syncStatus: "no repo",
			width: 104,
		};
		const plan = planHeader(props);
		expect(plan.middle.path).toBe(props.workspacePath);
		expect(plan.middle.sync).toBe("no repo");
		expect(plan.compactBrand).toBe(true);
	});

	test("when even the compact pill cannot show it whole, the tagline stays off", () => {
		const props = {
			...frame,
			workspacePath: "/Users/operator/8gent-code/.claude/worktrees/a-very-long-worktree-name-0123456789",
			width: 104,
		};
		const plan = planHeader(props);
		expect(plan.compactBrand).toBe(true);
		expect(plan.middle.branch).toBe(frame.branch);
	});
});
