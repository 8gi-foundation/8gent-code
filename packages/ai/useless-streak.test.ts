import { describe, expect, test } from "bun:test";
import type { TextToolMessage } from "./text-tool-client";
import { runTextToolAgent, type TextTool } from "./text-tool-loop";
import {
	DEFAULT_USELESS_STREAK,
	UselessStreak,
	isUselessResult,
	resolveUselessStreak,
	uselessStreakNote,
} from "./useless-streak";

const searchTool = (output: (args: Record<string, unknown>) => string): TextTool => ({
	spec: {
		name: "grep",
		description: "Search files",
		parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
	},
	run: async (args) => output(args),
});

const grepCall = (pattern: string) =>
	["```tool_call", JSON.stringify({ name: "grep", arguments: { pattern } }), "```"].join("\n");

const lastUser = (msgs: TextToolMessage[]) =>
	[...msgs].reverse().find((m) => m.role === "user")?.content ?? "";

describe("resolveUselessStreak (EIGHT_USELESS_STREAK)", () => {
	test("off by default and for 0 or junk", () => {
		expect(resolveUselessStreak({})).toBe(0);
		expect(resolveUselessStreak({ EIGHT_USELESS_STREAK: "0" })).toBe(0);
		expect(resolveUselessStreak({ EIGHT_USELESS_STREAK: "off" })).toBe(0);
	});
	test("1 or true means the default threshold, a number of 2 or more is the threshold", () => {
		expect(resolveUselessStreak({ EIGHT_USELESS_STREAK: "1" })).toBe(DEFAULT_USELESS_STREAK);
		expect(resolveUselessStreak({ EIGHT_USELESS_STREAK: "true" })).toBe(DEFAULT_USELESS_STREAK);
		expect(DEFAULT_USELESS_STREAK).toBe(5);
		expect(resolveUselessStreak({ EIGHT_USELESS_STREAK: "3" })).toBe(3);
	});
});

describe("isUselessResult", () => {
	test("empty output and executor errors are useless", () => {
		expect(isUselessResult("")).toBe(true);
		expect(isUselessResult("   \n")).toBe(true);
		expect(isUselessResult('Error running tool "grep": ENOENT')).toBe(true);
	});
	test("a gate refusal is not counted, and real output is not useless", () => {
		expect(isUselessResult("[TOOLG8 BLOCKED] policy")).toBe(false);
		expect(isUselessResult("[BLOCKED] chained command")).toBe(false);
		expect(isUselessResult("src/a.ts:3: match")).toBe(false);
	});
});

describe("UselessStreak", () => {
	test("five useless results trip it; a useful one resets", () => {
		const s = new UselessStreak(5);
		for (let i = 0; i < 4; i++) s.record("grep", { pattern: `p${i}` }, "");
		expect(s.tripped()).toBe(false);
		s.record("grep", { pattern: "hit" }, "a.ts:1: hit");
		expect(s.count).toBe(0);
		for (let i = 0; i < 5; i++) s.record("grep", { pattern: `q${i}` }, "");
		expect(s.tripped()).toBe(true);
	});
	test("an identical call that returns the identical result is no progress", () => {
		const s = new UselessStreak(3);
		for (let i = 0; i < 3; i++) s.record("read_file", { path: "a.ts" }, "same contents");
		// The first read was useful; the two repeats were not.
		expect(s.count).toBe(2);
	});
	test("a refused call neither counts nor resets", () => {
		const s = new UselessStreak(3);
		s.record("grep", { pattern: "a" }, "");
		s.record("run_command", { command: "x && y" }, "[BLOCKED] chained");
		s.record("grep", { pattern: "b" }, "");
		expect(s.count).toBe(2);
	});
	test("threshold 0 never trips", () => {
		const s = new UselessStreak(0);
		for (let i = 0; i < 20; i++) s.record("grep", { pattern: `${i}` }, "");
		expect(s.tripped()).toBe(false);
	});
});

describe("runTextToolAgent with uselessStreak", () => {
	test("after N empty results the next turn gets the note and no tools", async () => {
		const seen: TextToolMessage[][] = [];
		let n = 0;
		const call = async (msgs: TextToolMessage[]): Promise<string> => {
			seen.push(msgs);
			n++;
			// A model that never stops on its own: always another search.
			if (msgs.some((m) => m.role === "user" && m.content.includes("[harness] Stop searching"))) {
				return "I could not find it: every search came back empty.";
			}
			return grepCall(`attempt-${n}`);
		};
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Where is the config loaded?" }],
			tools: [searchTool(() => "")],
			call,
			maxRounds: 20,
			uselessStreak: 5,
		});
		expect(result.toolLog).toHaveLength(5);
		expect(seen).toHaveLength(6);
		const final = seen[5];
		expect(lastUser(final)).toContain(uselessStreakNote(5, ["grep"]));
		// Tools withheld: no tool protocol was injected into the answer turn.
		expect(final.some((m) => m.role === "system")).toBe(false);
		expect(result.content).toBe("I could not find it: every search came back empty.");
	});

	test("a tool call in the answer-only turn is not run", async () => {
		let n = 0;
		const call = async (): Promise<string> => {
			n++;
			return n <= 3 ? grepCall(`x${n}`) : `Nothing found.\n${grepCall("again")}`;
		};
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "find it" }],
			tools: [searchTool(() => "")],
			call,
			maxRounds: 20,
			uselessStreak: 3,
		});
		expect(result.toolLog).toHaveLength(3);
		expect(result.content).toContain("Nothing found.");
		expect(n).toBe(4);
	});

	test("four empties then a hit do not trip it", async () => {
		let n = 0;
		const call = async (msgs: TextToolMessage[]): Promise<string> => {
			n++;
			if (n <= 5) return grepCall(n === 5 ? "hit" : `miss-${n}`);
			expect(lastUser(msgs)).not.toContain("[harness] Stop searching");
			return "DONE: found it in a.ts";
		};
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "find it" }],
			tools: [searchTool((a) => (a.pattern === "hit" ? "a.ts:1: hit" : ""))],
			call,
			maxRounds: 20,
			uselessStreak: 5,
		});
		expect(result.toolLog).toHaveLength(5);
		expect(result.content).toContain("found it in a.ts");
	});

	test("off (no option) keeps today's behaviour: the loop runs to maxRounds", async () => {
		let n = 0;
		const call = async (): Promise<string> => grepCall(`p${++n}`);
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "find it" }],
			tools: [searchTool(() => "")],
			call,
			maxRounds: 8,
		});
		expect(result.toolLog).toHaveLength(8);
	});
});
