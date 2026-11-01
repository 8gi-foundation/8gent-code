import { afterEach, describe, expect, it } from "bun:test";
import { ToolArgGuard, schemaCheckOn } from "./tool-args";

const defs = (): object[] => [
	{
		type: "function",
		function: {
			name: "read_file",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
	},
	{ type: "function", function: { name: "fancy", parameters: { type: "object", anyOf: [{}] } } },
	{ type: "function", function: { name: "no_schema" } },
];

const saved = process.env.EIGHT_SCHEMA_CHECK;
afterEach(() => {
	if (saved === undefined) {
		// biome-ignore lint/performance/noDelete: an env var set to undefined becomes the string "undefined"
		delete process.env.EIGHT_SCHEMA_CHECK;
	} else process.env.EIGHT_SCHEMA_CHECK = saved;
});

describe("ToolArgGuard", () => {
	it("flag is off unless exactly 1", () => {
		// biome-ignore lint/performance/noDelete: see above
		delete process.env.EIGHT_SCHEMA_CHECK;
		expect(schemaCheckOn()).toBe(false);
		process.env.EIGHT_SCHEMA_CHECK = "true";
		expect(schemaCheckOn()).toBe(false);
		process.env.EIGHT_SCHEMA_CHECK = "1";
		expect(schemaCheckOn()).toBe(true);
	});
	it("logs nothing and builds nothing with the flag off", () => {
		// biome-ignore lint/performance/noDelete: see above
		delete process.env.EIGHT_SCHEMA_CHECK;
		const lines: string[] = [];
		let built = 0;
		const g = new ToolArgGuard(() => (built++, defs()), (l) => lines.push(l));
		g.observe("read_file", {});
		expect(lines).toEqual([]);
		expect(built).toBe(0);
	});
	it("logs a rejection, never throws, with the flag on", () => {
		process.env.EIGHT_SCHEMA_CHECK = "1";
		const lines: string[] = [];
		const g = new ToolArgGuard(defs, (l) => lines.push(l));
		expect(() => g.observe("read_file", { path: 3 })).not.toThrow();
		expect(lines.some((l) => l.includes("tool=read_file rejected") && l.includes("$.path: expected string, got number"))).toBe(true);
	});
	it("passes valid args silently", () => {
		process.env.EIGHT_SCHEMA_CHECK = "1";
		const lines: string[] = [];
		const g = new ToolArgGuard(defs, (l) => lines.push(l));
		g.observe("read_file", { path: "a" });
		expect(lines.filter((l) => l.includes("rejected"))).toEqual([]);
	});
	it("skips a tool using an unsupported keyword, once, and unknown tools", () => {
		process.env.EIGHT_SCHEMA_CHECK = "1";
		const lines: string[] = [];
		const g = new ToolArgGuard(defs, (l) => lines.push(l));
		expect(g.problems("fancy", { anything: 1 })).toEqual([]);
		expect(g.problems("no_schema", 1)).toEqual([]);
		expect(g.problems("missing", 1)).toEqual([]);
		g.problems("fancy", 2);
		expect(lines.filter((l) => l.includes("tool=fancy skipped")).length).toBe(1);
	});
	it("a failing defs() does not escape observe", () => {
		process.env.EIGHT_SCHEMA_CHECK = "1";
		const g = new ToolArgGuard(() => { throw new Error("boom"); }, () => {});
		expect(() => g.observe("x", {})).not.toThrow();
	});
});
