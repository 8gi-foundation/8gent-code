import { describe, expect, test } from "bun:test";
import {
	STATUS_MAX_CHARS,
	STATUS_REFRESH_MS,
	blockedSentence,
	foldedRow,
	showStepsWhileWorking,
	showsBlockedSentence,
	statusLine,
	statusStep,
	statusTool,
	stepPhrase,
	wrapSentence,
} from "./folded-trace.js";
import type { ToolTrailEntry } from "./tool-trail.js";

const settings = (showSteps?: boolean) => () => ({ ui: { showSteps } }) as never;

// The words a person never reads in the status row: paths, tool names, the gate's own name,
// the vendor and the model, and the a-word.
const BANNED = [
	/\//,
	/\.\w{1,4}\b/,
	/_/,
	/system ?one/i,
	/toolg8/i,
	/\bag[e]nt/i,
	/anthropic|openai|claude|gpt/i,
	/\bblocked\b|\bdenied\b|\berror\b|\bexit\b/i,
];

const TOOLS = [
	"read_file",
	"list_files",
	"search_files",
	"grep",
	"web_fetch",
	"run_command",
	"bash",
	"run_tests",
	"edit_file",
	"write_file",
	"apply_patch",
	"judge_check",
	"update_plan",
	"some_new_tool",
	"",
	null,
];

describe("stepPhrase", () => {
	test("maps a tool kind to a plain verb phrase", () => {
		expect(stepPhrase("read_file")).toBe("reading files");
		expect(stepPhrase("list_files")).toBe("reading files");
		expect(stepPhrase("search_files")).toBe("searching");
		expect(stepPhrase("grep")).toBe("searching");
		expect(stepPhrase("run_command")).toBe("running a check");
		expect(stepPhrase("run_tests")).toBe("running a check");
		expect(stepPhrase("edit_file")).toBe("editing a file");
		expect(stepPhrase("write_file")).toBe("editing a file");
		expect(stepPhrase("judge_check")).toBe("asking the judge");
		expect(stepPhrase("update_plan")).toBe("working on the next step");
		expect(stepPhrase(null)).toBe("thinking it through");
	});

	test("never carries a path, a tool name or a banned word", () => {
		for (const tool of TOOLS) {
			const line = statusLine({ tool, step: 3, seconds: 12 });
			const phrase = stepPhrase(tool);
			for (const re of BANNED) expect(phrase).not.toMatch(re);
			expect(line.startsWith("Working: ")).toBe(true);
		}
	});

	test("a path in a tool name or call never reaches the line", () => {
		const line = statusLine({ tool: "read_file packages/eight/secret.ts", step: 1, seconds: 0 });
		expect(line).toBe("Working: reading files (step 1, 0s)");
	});
});

describe("statusLine", () => {
	test("has the shape Working: <phrase> (step N, Ns)", () => {
		expect(statusLine({ tool: "read_file", step: 3, seconds: 12.9 })).toBe(
			"Working: reading files (step 3, 12s)",
		);
	});

	test("stays within 80 characters whatever the numbers", () => {
		const line = statusLine({ tool: "run_command", step: 1e30, seconds: 1e30 });
		expect(line.length).toBeLessThanOrEqual(STATUS_MAX_CHARS);
		expect(statusLine({ tool: "x", step: 999999, seconds: 999999 }).length).toBeLessThanOrEqual(80);
	});

	test("step is at least 1 and never negative time", () => {
		expect(statusLine({ tool: "read_file", step: 0, seconds: -5 })).toBe(
			"Working: reading files (step 1, 0s)",
		);
	});

	test("a narrow row drops the seconds, then the word step, never the phrase", () => {
		const o = { tool: "run_command", step: 12, seconds: 123 };
		expect(statusLine(o, 80)).toBe("Working: running a check (step 12, 123s)");
		expect(statusLine(o, 36)).toBe("Working: running a check (step 12)");
		expect(statusLine(o, 30)).toBe("Working: running a check (12)");
		expect(statusLine(o, 20)).toBe("running a check");
		expect(statusLine(o, 10)).toBe("running a…");
	});

	test("refreshes at most twice a second", () => {
		expect(STATUS_REFRESH_MS).toBeGreaterThanOrEqual(500);
	});
});

describe("statusTool and statusStep", () => {
	const trail: ToolTrailEntry[] = [
		{ tool: "read_file", summary: "a", status: "ok" },
		{ tool: "edit_file", summary: "b", status: "ok" },
	];
	test("the running call wins, else the newest finished one", () => {
		expect(statusTool("run_command", trail)).toBe("run_command");
		expect(statusTool(null, trail)).toBe("edit_file");
		expect(statusTool(null, [])).toBeNull();
	});
	test("counts finished calls plus the one in flight", () => {
		expect(statusStep(null, trail)).toBe(2);
		expect(statusStep("run_command", trail)).toBe(3);
		expect(statusStep(null, [])).toBe(1);
	});
});

describe("showStepsWhileWorking", () => {
	test("defaults to off", () => {
		expect(showStepsWhileWorking({}, settings(undefined))).toBe(false);
		expect(showStepsWhileWorking({}, settings(false))).toBe(false);
	});
	test("the setting turns it on", () => {
		expect(showStepsWhileWorking({}, settings(true))).toBe(true);
	});
	test("EIGHT_TUI_TRACE=on forces it on, off forces it off", () => {
		expect(showStepsWhileWorking({ EIGHT_TUI_TRACE: "on" }, settings(false))).toBe(true);
		expect(showStepsWhileWorking({ EIGHT_TUI_TRACE: "ON" }, settings(undefined))).toBe(true);
		expect(showStepsWhileWorking({ EIGHT_TUI_TRACE: "off" }, settings(true))).toBe(false);
	});
	test("an unreadable settings file means off", () => {
		const boom = () => {
			throw new Error("nope");
		};
		expect(showStepsWhileWorking({}, boom)).toBe(false);
	});
});

describe("blockedSentence", () => {
	const ok: ToolTrailEntry = { tool: "read_file", summary: "a", status: "ok" };
	test("null unless a blocked step ended the turn", () => {
		expect(blockedSentence([])).toBeNull();
		expect(blockedSentence([ok])).toBeNull();
		expect(
			blockedSentence([{ tool: "run_command", summary: "x", status: "blocked" }, ok]),
		).toBeNull();
		expect(
			blockedSentence([{ tool: "run_command", summary: "x", status: "fail", reason: "exit 1" }]),
		).toBeNull();
	});

	test("one plain sentence, what stopped and what to do, never the raw reason", () => {
		const s = blockedSentence([
			ok,
			{
				tool: "write_file",
				summary: "deck/secrets.md",
				status: "blocked",
				reason: "blocked: [no-secrets-in-files]",
			},
		]) as string;
		expect(s).toContain("editing a file");
		expect(s).toContain("Say so if you want it allowed");
		expect(s).not.toMatch(/permission mode|Shift\+Tab|settings|yolo/i);
		expect(s).not.toMatch(/no-secrets|deck|\[|SYSTEM ONE|TOOLG8|blocked:/i);
		expect(s).not.toContain(String.fromCharCode(0x2014));
		expect(s.match(/\./g)?.length).toBe(2);
	});

	test("denied and gate-named blocks read the same", () => {
		const s = blockedSentence([
			{ tool: "run_command", summary: "rm x", status: "blocked", reason: "denied" },
		]) as string;
		expect(s).toContain("running a check");
		expect(s).not.toMatch(/denied|SYSTEM ONE/i);
	});
});

describe("wrapSentence", () => {
	test("breaks on spaces and never exceeds the width", () => {
		const s = blockedSentence([{ tool: "edit_file", summary: "", status: "blocked" }]) as string;
		for (const w of [20, 36, 60, 90]) {
			const lines = wrapSentence(s, w);
			for (const l of lines) expect(l.length).toBeLessThanOrEqual(w);
			expect(lines.join(" ")).toBe(s);
		}
	});
	test("a word longer than the width is cut, not lost", () => {
		expect(wrapSentence("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
	});
});

describe("showsBlockedSentence", () => {
	test("only the turn that just ended, and only with no reply after the block", () => {
		expect(showsBlockedSentence({ justEnded: true, reply: "" })).toBe(true);
		expect(showsBlockedSentence({ justEnded: true, reply: "  \n" })).toBe(true);
		expect(showsBlockedSentence({ justEnded: true, reply: "I could not edit .env." })).toBe(false);
		expect(showsBlockedSentence({ justEnded: false, reply: "" })).toBe(false);
	});
});

describe("foldedRow", () => {
	const base = { tool: "read_file", step: 6, seconds: 12 };
	test("narrow: the marker carries the hint", () => {
		const closed = foldedRow({ marker: "▸", ...base, open: false, width: 34 });
		expect(closed.startsWith("▸ Enter: steps")).toBe(true);
		expect(closed.length).toBeLessThanOrEqual(34);
		const open = foldedRow({ marker: "▾", ...base, open: true, width: 34 });
		expect(open.startsWith("▾ Esc closes")).toBe(true);
		expect(open.length).toBeLessThanOrEqual(34);
		expect(foldedRow({ marker: "▸", ...base, open: false, width: 14 })).toBe("▸ Enter: steps");
	});
	test("wide: no hint while folded, Esc closes while open", () => {
		const closed = foldedRow({ marker: "▸", ...base, open: false, width: 90 });
		expect(closed).toBe("▸ Working: reading files (step 6, 12s)");
		const open = foldedRow({ marker: "▾", ...base, open: true, width: 90 });
		expect(open).toBe("▾ Working: reading files (step 6, 12s) - Esc closes");
		for (const w of [54, 60, 90]) {
			expect(foldedRow({ marker: "▾", ...base, open: true, width: w }).length).toBeLessThanOrEqual(
				w,
			);
		}
	});
});
