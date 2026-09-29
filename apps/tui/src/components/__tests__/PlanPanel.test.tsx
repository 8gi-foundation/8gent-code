/**
 * The PLAN column: steps come only from what the agent writes (PLAN: text,
 * update_plan calls). These tests pin the honesty rules and render the real
 * panel through Ink.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { useEffect, useState } from "react";
import type { PlanStep } from "../../lib/plan-state.js";
import { planStepsFromText } from "../../lib/activity-rail-derivation.js";
import { applyPlanUpdate, mergePlanText, normaliseStatus, settlePlan } from "../../lib/plan-state.js";
import { PlanPanel, formatElapsed, planColumnOpen, planSummary } from "../PlanPanel.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

async function frames(node: React.ReactElement, ms = 60): Promise<string[]> {
	const out = new EventEmitter() as EventEmitter & {
		columns: number;
		rows: number;
		isTTY: boolean;
		frames: string[];
		write: (s: string) => boolean;
	};
	out.columns = 40;
	out.rows = 20;
	out.isTTY = false;
	out.frames = [];
	out.write = (s: string) => {
		out.frames.push(strip(s));
		return true;
	};
	const app = render(node, { stdout: out as unknown as NodeJS.WriteStream, debug: true, patchConsole: false });
	await new Promise((r) => setTimeout(r, ms));
	app.unmount();
	return out.frames;
}

describe("plan text", () => {
	test("a one-line plan splits into one step per number", () => {
		expect(planStepsFromText("PLAN: 1) Read app.tsx 2) Patch the rail 3) Run tests")).toEqual([
			"Read app.tsx",
			"Patch the rail",
			"Run tests",
		]);
	});

	test("version numbers inside a step do not split it", () => {
		expect(planStepsFromText("PLAN:\n1. Bump to v2.1 and 1.2\n2. Tag it")).toEqual(["Bump to v2.1 and 1.2", "Tag it"]);
	});
});

describe("plan state", () => {
	test("text alone never marks progress", () => {
		const steps = mergePlanText([], ["Read", "Write"]);
		expect(steps.map((s) => s.status)).toEqual(["pending", "pending"]);
	});

	test("rewriting the plan keeps statuses and appends new steps at the end", () => {
		const a = applyPlanUpdate(mergePlanText([], ["Read", "Write"]), [
			{ step: "Read", status: "completed" },
			{ step: "Write", status: "in_progress" },
		]);
		const b = mergePlanText(a, ["Read", "Write", "Test"]);
		expect(b.map((s) => [s.text, s.status])).toEqual([
			["Read", "done"],
			["Write", "active"],
			["Test", "pending"],
		]);
		expect(b[0]!.id).toBe(a[0]!.id);
	});

	test("update_plan is the authority, with one active step at most", () => {
		const steps = applyPlanUpdate([], [
			{ step: "A", status: "in_progress" },
			{ step: "B", status: "in_progress" },
			{ step: "C", status: "error" },
			{ step: "", status: "done" },
			{ status: "done" },
		]);
		expect(steps.map((s) => [s.text, s.status])).toEqual([
			["A", "active"],
			["B", "pending"],
			["C", "failed"],
		]);
		expect(normaliseStatus(undefined)).toBe("pending");
	});

	test("settling never ticks an unfinished step", () => {
		const settled = settlePlan(applyPlanUpdate([], [{ step: "A", status: "in_progress" }]));
		expect(settled[0]!.status).toBe("pending");
	});
});

describe("summary", () => {
	const steps = applyPlanUpdate([], [
		{ step: "A", status: "completed" },
		{ step: "B", status: "failed" },
		{ step: "C", status: "completed" },
	]);

	test("counts only what the steps carry, packed to the width", () => {
		expect(planSummary(steps, 130000, 80)).toEqual(["2 of 3 done · 1 failed · 2m 10s"]);
		expect(planSummary(steps, 130000, 22)).toEqual(["2 of 3 done · 1 failed", "2m 10s"]);
	});

	test("with no progress reports it says the plan, not a score", () => {
		expect(planSummary(mergePlanText([], ["A", "B"]), null)).toEqual(["2 steps planned"]);
	});

	test("elapsed reads as a person would say it", () => {
		expect(formatElapsed(9000)).toBe("9s");
		expect(formatElapsed(120000)).toBe("2m");
		expect(formatElapsed(130000)).toBe("2m 10s");
	});
});

describe("column open or closed", () => {
	test("auto follows content, the user's choice wins", () => {
		expect(planColumnOpen("auto", true)).toBe(true);
		expect(planColumnOpen("auto", false)).toBe(false);
		expect(planColumnOpen("hidden", true)).toBe(false);
		expect(planColumnOpen("shown", false)).toBe(true);
	});
});

describe("PlanPanel render", () => {
	test("current step, ticks, a failure and the settled summary", async () => {
		const steps = applyPlanUpdate([], [
			{ step: "Read the package", status: "completed" },
			{ step: "Write the outline", status: "failed" },
			{ step: "Save it", status: "completed" },
		]);
		const last = (await frames(<PlanPanel steps={steps} running={false} elapsedMs={65000} width={30} animate={false} />)).at(-1) ?? "";
		expect(last).toContain("PLAN");
		expect(last).toContain("2/3");
		expect(last).toContain("✓ Read the package");
		expect(last).toContain("✗ Write the outline");
		expect(last).toContain("2 of 3 done · 1 failed");
		expect(last).toContain("1m 5s");
	});

	test("steps written together land one after another", async () => {
		const steps = mergePlanText([], ["A one", "B two", "C three"]);
		// Mount with no steps, then the plan arrives: rows must land in turn.
		function Late() {
			const [s, setS] = useState<PlanStep[]>([]);
			useEffect(() => {
				const id = setTimeout(() => setS(steps), 10);
				return () => clearTimeout(id);
			}, []);
			return <PlanPanel steps={s} running width={30} />;
		}
		const seen = (await frames(<Late />, 400)).map((f) => ["A one", "B two", "C three"].filter((x) => f.includes(x)).length);
		expect(seen).toContain(1);
		expect(seen).toContain(2);
		expect(seen.at(-1)).toBe(3);
		for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
	});

	test("while running there is no summary yet", async () => {
		const steps = applyPlanUpdate([], [{ step: "Only", status: "in_progress" }]);
		const last = (await frames(<PlanPanel steps={steps} running width={30} animate={false} />)).at(-1) ?? "";
		expect(last).toContain("Only");
		expect(last).not.toContain("done");
	});
});
