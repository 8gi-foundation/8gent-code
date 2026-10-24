/**
 * Tab lamps (#4928): the state-to-lamp mapping, the one-shot transitions and
 * their timing, and the screen-reader text.
 */
import { describe, expect, test } from "bun:test";
import { MOTION_BUDGET_MS } from "./motion.js";
import {
	LAMP_PRIORITY,
	LAMP_WORD,
	type LampInput,
	type LampState,
	VISIT_HOLD_MS,
	approvalOwner,
	barAriaLabel,
	deriveLamp,
	lampGlyph,
	lampTransition,
	nextUnread,
	restFrame,
	transitionMs,
	worstLamp,
} from "./tab-lamps.js";

const none: LampInput = { needsYou: false, processing: false, unread: null };

describe("state to lamp", () => {
	test("each single state maps to its lamp", () => {
		expect(deriveLamp(none)).toBe("idle");
		expect(deriveLamp({ ...none, processing: true })).toBe("working");
		expect(deriveLamp({ ...none, needsYou: true })).toBe("needs");
		expect(deriveLamp({ ...none, unread: "done" })).toBe("done");
		expect(deriveLamp({ ...none, unread: "failed" })).toBe("failed");
	});

	test("priority: needs you, failed, working, done, idle", () => {
		const all = { needsYou: true, processing: true, unread: "failed" as const };
		expect(deriveLamp(all)).toBe("needs");
		expect(deriveLamp({ ...all, needsYou: false })).toBe("failed");
		expect(deriveLamp({ needsYou: false, processing: true, unread: "done" })).toBe("working");
		expect(deriveLamp({ needsYou: false, processing: false, unread: "done" })).toBe("done");
		expect([...LAMP_PRIORITY]).toEqual(["needs", "failed", "working", "done", "idle"]);
	});

	test("worstLamp picks the most urgent for the overflow cell", () => {
		expect(worstLamp(["idle", "done", "needs"])).toBe("needs");
		expect(worstLamp(["idle", "working"])).toBe("working");
		expect(worstLamp([])).toBe("idle");
	});

	test("shapes are distinct, rich and ascii, so colour is never the signal", () => {
		const states: LampState[] = ["idle", "working", "needs", "done", "failed"];
		const rich = states.map((s) => lampGlyph(restFrame(s), false));
		const ascii = states.map((s) => lampGlyph(restFrame(s), true));
		expect(rich).toEqual(["·", "◐", "▲", "●", "✕"]);
		expect(new Set(rich).size).toBe(5);
		expect(new Set(ascii).size).toBe(5);
	});

	test("only needs you is orange, and every state has a spoken word", () => {
		for (const s of ["idle", "working", "done", "failed"] as const) {
			expect(restFrame(s).tone).not.toBe("orange");
		}
		expect(restFrame("needs").tone).toBe("orange");
		expect(restFrame("needs").bold).toBe(true);
		expect(LAMP_WORD.needs).toBe("needs you");
	});

	test("the active tab's lamp is inverse only when it needs you", () => {
		expect(restFrame("needs", true).inverse).toBe(true);
		expect(restFrame("needs", false).inverse).toBe(false);
		for (const s of ["idle", "working", "done", "failed"] as const) {
			expect(restFrame(s, true).inverse).toBe(false);
		}
	});
});

describe("transitions", () => {
	const states: LampState[] = ["idle", "working", "needs", "done", "failed"];

	test("every transition ends on its resting frame and stays inside the budget", () => {
		for (const from of states) {
			for (const to of states) {
				for (const visited of [false, true]) {
					const frames = lampTransition(from, to, { visited });
					const last = frames.at(-1)!;
					expect(last.ms).toBe(0);
					expect(last).toEqual(restFrame(to));
					expect(transitionMs(frames)).toBeLessThanOrEqual(MOTION_BUDGET_MS);
				}
			}
		}
	});

	test("into done: the fill completes, 140 ms", () => {
		const frames = lampTransition("working", "done");
		expect(frames.map((f) => f.rich)).toEqual(["◐", "◑", "●"]);
		expect(transitionMs(frames)).toBe(140);
	});

	test("into failed: marked once, 60 ms, lands on the cross", () => {
		const frames = lampTransition("working", "failed");
		expect(frames.map((f) => f.rich)).toEqual(["✕", "✕"]);
		expect(frames[0]!.inverse).toBe(true);
		expect(transitionMs(frames)).toBe(60);
	});

	test("into needs you: the triangle is on the first frame, not a frame late", () => {
		const frames = lampTransition("idle", "needs");
		expect(frames[0]!.rich).toBe("▲");
		expect(frames.at(-1)!.inverse).toBe(false);
		expect(transitionMs(frames)).toBeLessThanOrEqual(120);
	});

	test("into working: one 50 ms beat from the idle dot", () => {
		const frames = lampTransition("idle", "working");
		expect(frames.map((f) => f.rich)).toEqual(["·", "◐"]);
		expect(transitionMs(frames)).toBe(50);
	});

	test("visiting a done or failed tab holds the lamp 120 ms, then clears", () => {
		for (const from of ["done", "failed"] as const) {
			const frames = lampTransition(from, "idle", { visited: true });
			expect(frames[0]!.rich).toBe(restFrame(from).rich);
			expect(frames[0]!.ms).toBe(VISIT_HOLD_MS);
			expect(VISIT_HOLD_MS).toBe(120);
			expect(frames.at(-1)!.rich).toBe("·");
		}
	});

	test("no change is no motion", () => {
		expect(lampTransition("done", "done")).toEqual([restFrame("done")]);
	});

	test("nothing in the data loops: every non-final frame has a positive hold", () => {
		for (const from of states) {
			for (const to of states) {
				const frames = lampTransition(from, to, { visited: true });
				for (const f of frames.slice(0, -1)) expect(f.ms).toBeGreaterThan(0);
			}
		}
	});
});

describe("screen reader text", () => {
	test("every tab's state is a word in the bar's label", () => {
		const label = barAriaLabel([
			{ title: "Orchestrator", state: "working" },
			{ title: "Engineer", state: "idle" },
			{ title: "QA", state: "needs" },
			{ title: "Notes", state: "done" },
		]);
		expect(label).toBe(
			"Tabs: 1 Orchestrator working, 2 Engineer idle, 3 QA needs you, 4 Notes done",
		);
	});

	test("tabs the bar could not fit are counted, never silent", () => {
		expect(barAriaLabel([{ title: "A", state: "idle" }], 2)).toBe(
			"Tabs: 1 A idle, 2 more not shown",
		);
	});
});

describe("who an approval belongs to", () => {
	test("the focused tab when it is running, else the first running tab, else the focused tab", () => {
		expect(approvalOwner("a", ["b", "a"])).toBe("a");
		expect(approvalOwner("a", ["b", "c"])).toBe("b");
		expect(approvalOwner("a", [])).toBe("a");
	});
});

describe("unread tabs", () => {
	const no = () => false;
	test("a background turn that ends is done, or failed when it ended in error", () => {
		expect(nextUnread({}, new Set(["b"]), new Set(), "a", no)).toEqual({ b: "done" });
		expect(nextUnread({}, new Set(["b"]), new Set(), "a", () => true)).toEqual({ b: "failed" });
	});
	test("the focused tab never goes unread, and opening a tab clears it", () => {
		expect(nextUnread({}, new Set(["a"]), new Set(), "a", no)).toEqual({});
		expect(nextUnread({ b: "done" }, new Set(), new Set(), "b", no)).toEqual({});
	});
	test("a turn still running stays as it was", () => {
		expect(nextUnread({}, new Set(["b"]), new Set(["b"]), "a", no)).toEqual({});
		expect(nextUnread({ c: "failed" }, new Set(["b"]), new Set(["b"]), "a", no)).toEqual({
			c: "failed",
		});
	});
});
