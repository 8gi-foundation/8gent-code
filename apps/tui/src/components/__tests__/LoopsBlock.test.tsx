import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import React from "react";
import type { LoopRow } from "../../lib/control-state.js";
import { ActivityRail, type ActivityRailProps, railSpareRows } from "../ActivityRail";
import { loopsBlockRows, topLoops } from "../LoopsBlock";

const row = (name: string, state: LoopRow["state"]): LoopRow => ({
	kind: "k",
	name,
	state,
	stage: "",
	last: null,
	next: null,
	waitingOn: null,
	detail: "",
});

const loops = [
	row("disk prune", "waiting-on-you"),
	row("builder 1", "running"),
	row("reviewer", "running"),
	row("merge queue", "queued"),
	row("release", "queued"),
	row("old draft", "stalled"),
	row("scout", "done"),
];

const props: ActivityRailProps = {
	tasks: [{ id: "t", label: "patch HeaderBar", progress: 35 }],
	tools: [],
	providers: [
		{ name: "8gent:eight-1.0-q3:14b", state: "primary" },
		{ name: "ollama:qwen3.8", state: "fallback" },
	],
	agents: [
		{ name: "Core", state: "active" },
		{ name: "Research", state: "idle" },
		{ name: "Tester", state: "idle" },
		{ name: "Reviewer", state: "idle" },
	],
	bodyParts: { hands: "idle", eyes: "idle", handeyes: "disabled" },
};

const draw = (p: Partial<ActivityRailProps>) =>
	renderToString(<ActivityRail {...props} {...p} />, { columns: 34 });

describe("side panel LOOPS block", () => {
	test("shows the top five by urgency under 8GENT ACTIVITY on a tall terminal", () => {
		const out = draw({ height: 72, loopRows: loops });
		expect(out).toContain("8GENT ACTIVITY");
		expect(out).toContain("LOOPS");
		expect(out.indexOf("LOOPS")).toBeGreaterThan(out.indexOf("8GENTS"));
		for (const n of ["disk prune", "builder 1", "reviewer", "merge queue", "release"])
			expect(out).toContain(n);
		expect(out).not.toContain("old draft");
		expect(out).not.toContain("scout");
	});

	test("is hidden when the rail has no spare rows, and when no height is given", () => {
		expect(draw({ height: 30, loopRows: loops })).not.toContain("LOOPS");
		expect(draw({ loopRows: loops })).not.toContain("LOOPS");
	});

	test("is hidden when there are no loops, and the rest of the rail is unchanged", () => {
		const without = draw({});
		expect(draw({ height: 72, loopRows: [] })).toBe(without);
		expect(draw({ height: 72, loopRows: [] })).not.toContain("LOOPS");
	});

	test("takes only the rows that are free", () => {
		const spare = railSpareRows(38, props);
		const out = draw({ height: 38, loopRows: loops });
		const shown = loops.filter((l) => out.includes(l.name)).length;
		expect(shown).toBe(loopsBlockRows(spare));
		expect(loopsBlockRows(2)).toBe(0);
		expect(loopsBlockRows(3)).toBe(1);
		expect(loopsBlockRows(99)).toBe(5);
		expect(topLoops(loops, 5).length).toBe(5);
	});
});
