/**
 * decompose.test.ts - bun:test coverage for the decompose planner.
 * No live model: ThinkerCall is mocked with canned completions.
 */

import { describe, expect, test } from "bun:test";
import { decompose, topoSortUnits, type ThinkerCall } from "./decompose.js";
import type { BuildUnit } from "./pipeline-contracts.js";

/** Make a ThinkerCall that always returns the given string. */
function constCall(out: string): ThinkerCall {
	return async () => out;
}

const THREE_UNIT_JSON = JSON.stringify({
	projectType: "static-site",
	summary: "A tiny site",
	units: [
		{ id: "page", path: "index.html", kind: "page", spec: "Home page using the card.", dependsOn: ["card", "styles"] },
		{ id: "styles", path: "styles.css", kind: "style", spec: "Base styles.", dependsOn: [] },
		{ id: "card", path: "card.html", kind: "component", spec: "A card partial.", dependsOn: ["styles"] },
	],
});

describe("decompose", () => {
	test("parses a valid 3-unit plan and topo-sorts deps before dependents", async () => {
		const plan = await decompose({ task: "build a site", call: constCall(THREE_UNIT_JSON) });

		expect(plan.projectType).toBe("static-site");
		expect(plan.units).toHaveLength(3);

		const order = plan.units.map((u) => u.id);
		// styles before card before page (deps must precede dependents).
		expect(order.indexOf("styles")).toBeLessThan(order.indexOf("card"));
		expect(order.indexOf("card")).toBeLessThan(order.indexOf("page"));
		// dependsOn defaults preserved.
		expect(plan.units.find((u) => u.id === "styles")?.dependsOn).toEqual([]);
	});

	test("parses JSON wrapped in ```json fences with surrounding prose", async () => {
		const wrapped = [
			"Sure, here is the plan you asked for:",
			"```json",
			THREE_UNIT_JSON,
			"```",
			"Let me know if you want changes.",
		].join("\n");

		const plan = await decompose({ task: "build a site", call: constCall(wrapped) });
		expect(plan.units).toHaveLength(3);
		expect(plan.units.map((u) => u.id)).toContain("card");
	});

	test("returns a fallback plan with >=1 unit on garbage output", async () => {
		const plan = await decompose({ task: "build a thing", call: constCall("I cannot do that.") });

		expect(plan.units.length).toBeGreaterThanOrEqual(1);
		expect(plan.summary.toLowerCase()).toContain("fallback");
		expect(plan.units[0].spec).toContain("build a thing");
	});

	test("drops malformed units but keeps valid ones", async () => {
		const mixed = JSON.stringify({
			projectType: "node-cli",
			summary: "mixed",
			units: [
				{ id: "good", path: "cli.ts", kind: "module", spec: "Entry point." },
				{ id: "noPath", kind: "module", spec: "missing path" },
				{ path: "noSpec.ts", kind: "module" },
				"not an object",
			],
		});

		const plan = await decompose({ task: "cli", call: constCall(mixed) });
		expect(plan.units).toHaveLength(1);
		const good = plan.units[0];
		expect(good.id).toBe("good");
		// missing dependsOn coerced to [].
		expect(good.dependsOn).toEqual([]);
	});

	test("falls back when the thinker call throws", async () => {
		const throwing: ThinkerCall = async () => {
			throw new Error("model offline");
		};
		const plan = await decompose({ task: "anything", call: throwing });
		expect(plan.units.length).toBeGreaterThanOrEqual(1);
		expect(plan.summary.toLowerCase()).toContain("fallback");
	});

	test("injects structureNote into the system prompt", async () => {
		let seenSystem = "";
		const spy: ThinkerCall = async (system) => {
			seenSystem = system;
			return THREE_UNIT_JSON;
		};
		await decompose({ task: "x", structureNote: "SCAFFOLD: src/, public/", call: spy });
		expect(seenSystem).toContain("SCAFFOLD: src/, public/");
	});
});

describe("topoSortUnits", () => {
	const u = (id: string, dependsOn: string[]): BuildUnit => ({
		id,
		path: `${id}.ts`,
		kind: "module",
		spec: `unit ${id}`,
		dependsOn,
	});

	test("orders a small graph so dependencies precede dependents", () => {
		const sorted = topoSortUnits([u("c", ["b"]), u("a", []), u("b", ["a"])]);
		const order = sorted.map((x) => x.id);
		expect(order).toEqual(["a", "b", "c"]);
	});

	test("tolerates cycles by appending leftovers in original order", () => {
		const sorted = topoSortUnits([u("x", ["y"]), u("y", ["x"]), u("z", [])]);
		// z has no deps -> emitted first; x and y form a cycle -> appended as given.
		expect(sorted.map((s) => s.id)).toEqual(["z", "x", "y"]);
	});

	test("tolerates edges to unknown ids (treated as satisfied)", () => {
		const sorted = topoSortUnits([u("only", ["missing"])]);
		expect(sorted.map((s) => s.id)).toEqual(["only"]);
	});
});
