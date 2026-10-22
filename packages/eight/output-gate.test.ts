import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTextToolAgent } from "../ai/text-tool-loop";
import { OutputGate, isOutputGateEnabled, namedOutputs, outputNudge } from "./output-gate";

let cwd: string;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "output-gate-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const TASK = "Solve the puzzle and write answer.json with the grid.";

/** Drive the real text-tool loop with a scripted model; gate wired exactly as agent.ts wires it. */
async function run(gate: OutputGate, replies: string[]) {
	const seen: string[] = [];
	let i = 0;
	const write = {
		spec: {
			name: "write_file",
			description: "Write a file",
			parameters: {
				type: "object",
				properties: { path: { type: "string" }, content: { type: "string" } },
				required: ["path", "content"],
			},
		},
		run: async (args: Record<string, unknown>) => {
			writeFileSync(join(cwd, String(args.path)), String(args.content));
			return "ok";
		},
	};
	const out = await runTextToolAgent({
		messages: [{ role: "user", content: TASK }],
		tools: [write as any],
		maxRounds: 8,
		outputCheck: (r) => gate.check(r),
		call: async (msgs) => {
			seen.push(String(msgs.at(-1)?.content));
			return replies[Math.min(i++, replies.length - 1)];
		},
	});
	return { out, seen };
}

describe("namedOutputs", () => {
	test("by extension and by keyword", () => {
		expect(namedOutputs("write answer.json and notes.md")).toEqual(["answer.json", "notes.md"]);
		expect(namedOutputs("save to out/result and output: report")).toContain("out/result");
		expect(namedOutputs("see https://x.io/a.json")).toEqual([]);
		expect(namedOutputs("just explain the grid")).toEqual([]);
	});
});

describe("OutputGate", () => {
	test("flag off is inert", () => {
		const g = new OutputGate(TASK, cwd, false);
		expect(g.check("done")).toBeNull();
		expect(g.settle("done")).toBe("done");
		expect(isOutputGateEnabled({}, undefined)).toBe(false);
		expect(isOutputGateEnabled({ EIGHT_OUTPUT_GATE: "1" })).toBe(true);
	});
	test("no named path is inert", () => {
		const g = new OutputGate("explain how the grid works", cwd, true);
		expect(g.check("It works like this.")).toBeNull();
	});
	test("a path that exists at turn start is not required", () => {
		writeFileSync(join(cwd, "answer.json"), "{}");
		expect(new OutputGate(TASK, cwd, true).check("done")).toBeNull();
	});
	test("one-line explanation after one nudge ends the turn", () => {
		const g = new OutputGate(TASK, cwd, true);
		expect(g.check("Let me look at the grid.")).toBe(outputNudge("answer.json"));
		expect(g.check("It cannot be written: the input grid is empty.")).toBeNull();
		expect(g.settle("x")).toBe("x");
		expect(g.events.map((e) => e.action)).toEqual(["nudge", "explained"]);
	});
	test("two nudges then the missing list is appended", () => {
		const g = new OutputGate(TASK, cwd, true);
		expect(g.check("a\nb")).not.toBeNull();
		expect(g.check("a\nb")).not.toBeNull();
		expect(g.check("a\nb")).toBeNull();
		expect(g.settle("final")).toContain("Required output still missing: answer.json");
	});
});

describe("through the text-tool loop", () => {
	test("nudge, then write, then end", async () => {
		const gate = new OutputGate(TASK, cwd, true);
		const { seen } = await run(gate, [
			"The block placement seems to encode something.\nLet me look.",
			'```tool_call\n{"name":"write_file","arguments":{"path":"answer.json","content":"[]"}}\n```',
			"Wrote answer.json.",
		]);
		expect(seen.some((m) => m.startsWith("Required output answer.json does not exist yet"))).toBe(
			true,
		);
		expect(existsSync(join(cwd, "answer.json"))).toBe(true);
		expect(gate.events.map((e) => e.action)).toEqual(["nudge"]);
	});
	test("explaining why ends after one nudge", async () => {
		const gate = new OutputGate(TASK, cwd, true);
		const { seen } = await run(gate, [
			"Looking at it.\nHmm.",
			"Cannot write it: no grid was given.",
		]);
		expect(seen.filter((m) => m.startsWith("Required output")).length).toBe(1);
		expect(gate.events.map((e) => e.action)).toEqual(["nudge", "explained"]);
	});
});
