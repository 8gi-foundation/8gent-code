import { describe, expect, test } from "bun:test";
import { MockBackend } from "../../decide/backends/mock.js";
import { createDecider } from "../../decide/index.js";
import type { ChoiceAnswer } from "../../decide/types.js";
import { fromAxElements, fromDomElements } from "./adapters.js";
import {
	type ChoiceElement,
	MAX_ELEMENTS,
	MIN_CONFIDENCE,
	MIN_MARGIN,
	NONE_OPTION,
	chooseElement,
	isRisky,
	optionLine,
	positionHint,
	prefilter,
	textFor,
} from "./index.js";

const el = (
	index: number,
	role: string,
	label: string,
	x = 10,
	y = 10,
	extra: Partial<ChoiceElement> = {},
): ChoiceElement => ({
	index,
	role,
	label,
	rect: { x, y, w: 80, h: 24 },
	...extra,
});

const page: ChoiceElement[] = [
	el(0, "a", "Home", 10, 10),
	el(1, "input", "Email address", 300, 200),
	el(2, "input", "Password", 300, 260),
	el(3, "button", "Sign in", 300, 320),
	el(4, "button", "Delete account", 300, 600),
];

const mock = createDecider({ backend: new MockBackend(), cacheSize: 0 });

/** A decider that answers a fixed distribution, to drive the threshold branches. */
function fixed(probabilities: number[]) {
	return {
		choice: async (): Promise<
			ChoiceAnswer & { backend: string; model: string; latencyMs: number }
		> => {
			let chosen = 0;
			for (let i = 1; i < probabilities.length; i++)
				if (probabilities[i] > probabilities[chosen]) chosen = i;
			return {
				id: "q",
				kind: "choice",
				probabilities,
				chosen,
				confidence: probabilities[chosen],
				backend: "fixed",
				model: "fixed",
				latencyMs: 0,
			};
		},
	};
}

describe("chooseElement with the mock decider", () => {
	test("picks the Sign in button for a click intent", async () => {
		const out = await chooseElement({
			elements: page,
			intent: "click the Sign in button",
			decider: mock,
		});
		expect(out.status).toBe("CHOSEN");
		if (out.status !== "CHOSEN") return;
		expect(out.index).toBe(3);
		expect(out.action).toBe("click");
		expect(out.hidden).toBe(1);
		expect(out.candidates).toBe(4);
		expect(out.margin).toBeGreaterThan(0);
	});

	test("type intent carries the caller's value and never the model's", async () => {
		const out = await chooseElement({
			elements: page,
			intent: "type the email into the email address field",
			inputs: { email: "a@b.c" },
			decider: mock,
		});
		expect(out.status).toBe("CHOSEN");
		if (out.status !== "CHOSEN") return;
		expect(out.index).toBe(1);
		expect(out.action).toBe("type");
		expect(out.text).toBe("a@b.c");
	});

	test("type intent with no input is NEEDS_INPUT naming the field", async () => {
		const out = await chooseElement({ elements: page, intent: "type the password", decider: mock });
		expect(out).toEqual({ status: "NEEDS_INPUT", missing: ["password"] });
	});

	test("empty list is NO_NODE so the caller can fall back to ground()", async () => {
		expect(await chooseElement({ elements: [], intent: "click Save", decider: mock })).toEqual({
			status: "NO_NODE",
		});
	});

	test("risky intent is NEEDS_AGENT unless allowRisky", async () => {
		const blocked = await chooseElement({
			elements: page,
			intent: "click Delete account",
			decider: mock,
		});
		expect(blocked.status).toBe("NEEDS_AGENT");
		const allowed = await chooseElement({
			elements: page,
			intent: "click Delete account",
			allowRisky: true,
			decider: mock,
		});
		expect(allowed.status).toBe("CHOSEN");
		if (allowed.status === "CHOSEN") expect(allowed.index).toBe(4);
	});

	test("hidden elements are not visible to the model", async () => {
		const hiddenOnly = page.map((e) => ({ ...e, visible: false }));
		const out = await chooseElement({
			elements: hiddenOnly,
			intent: "click Sign in",
			decider: mock,
		});
		expect(out.status).toBe("NEEDS_AGENT");
	});

	test("a decider error becomes NEEDS_AGENT, not a throw", async () => {
		const broken = {
			choice: async () => {
				throw new Error("ollama unreachable");
			},
		};
		const out = await chooseElement({ elements: page, intent: "click Home", decider: broken });
		expect(out.status).toBe("NEEDS_AGENT");
		if (out.status === "NEEDS_AGENT") expect(out.reason).toContain("ollama unreachable");
	});
});

describe("thresholds (code owns them, not the model)", () => {
	const two = page.slice(0, 2);
	test("low confidence is NEEDS_AGENT", async () => {
		const out = await chooseElement({
			elements: two,
			intent: "click Home",
			decider: fixed([0.34, 0.33, 0.33]),
		});
		expect(out.status).toBe("NEEDS_AGENT");
		if (out.status === "NEEDS_AGENT") expect(out.reason).toContain(`${MIN_CONFIDENCE}`);
	});
	test("thin margin is NEEDS_AGENT", async () => {
		const out = await chooseElement({
			elements: two,
			intent: "click Home",
			decider: fixed([0.46, 0.44, 0.1]),
		});
		expect(out.status).toBe("NEEDS_AGENT");
		if (out.status === "NEEDS_AGENT") expect(out.reason).toContain(`${MIN_MARGIN}`);
	});
	test("the none option is NEEDS_AGENT", async () => {
		const out = await chooseElement({
			elements: two,
			intent: "click Home",
			decider: fixed([0.1, 0.1, 0.8]),
		});
		expect(out.status).toBe("NEEDS_AGENT");
		if (out.status === "NEEDS_AGENT") expect(out.reason).toContain("none");
	});
	test("a clear pick is CHOSEN with its margin", async () => {
		const out = await chooseElement({
			elements: two,
			intent: "click Home",
			decider: fixed([0.8, 0.15, 0.05]),
		});
		expect(out.status).toBe("CHOSEN");
		if (out.status === "CHOSEN") expect(out.margin).toBeCloseTo(0.65);
	});
	test("one candidate still gets the none exit, so the choice has two options", async () => {
		let seen: string[] = [];
		const spy = {
			choice: async (_s: string, _p: string, options: string[]) => {
				seen = options;
				return await fixed([0.9, 0.1]).choice();
			},
		};
		const out = await chooseElement({ elements: [page[3]], intent: "click Sign in", decider: spy });
		expect(seen).toHaveLength(2);
		expect(seen[1]).toBe(NONE_OPTION);
		expect(out.status).toBe("CHOSEN");
	});
});

describe("prefilter", () => {
	const many = Array.from({ length: 60 }, (_, i) => el(i, "a", `Item ${i}`, 10, 20 * i));
	test("keeps everything under the cap, drops invisible and disabled rows", () => {
		const rows = [page[0], { ...page[1], visible: false }, { ...page[2], enabled: false }];
		expect(prefilter(rows, "x").kept.map((e) => e.index)).toEqual([0]);
		expect(prefilter(rows, "x").prefiltered).toBe(false);
	});
	test("over the cap: intent words win, order is preserved, and it says so", () => {
		const target = el(99, "button", "Export report", 10, 5000);
		const { kept, prefiltered } = prefilter([...many, target], "click the Export report button");
		expect(prefiltered).toBe(true);
		expect(kept).toHaveLength(MAX_ELEMENTS);
		expect(kept[kept.length - 1].index).toBe(99);
		expect(kept.slice(0, -1).map((e) => e.index)).toEqual(
			kept
				.slice(0, -1)
				.map((e) => e.index)
				.sort((a, b) => a - b),
		);
	});
	test("the model sees at most 26 options after prefiltering", async () => {
		let n = 0;
		const spy = {
			choice: async (_s: string, _p: string, options: string[]) => {
				n = options.length;
				return fixed(options.map((_, i) => (i === 0 ? 0.9 : 0.1 / (options.length - 1)))).choice();
			},
		};
		const out = await chooseElement({ elements: many, intent: "click Item 7", decider: spy });
		expect(n).toBe(26);
		expect(out.status).toBe("CHOSEN");
		if (out.status === "CHOSEN") expect(out.prefiltered).toBe(true);
	});
});

describe("helpers", () => {
	test("textFor picks the named key, the only key, or reports what is missing", () => {
		expect(textFor("type the email", { email: "e", password: "p" })).toEqual({
			text: "e",
			missing: "email",
		});
		expect(textFor("type it in", { q: "cats" })).toEqual({ text: "cats", missing: "q" });
		expect(textFor("enter the username field", {})).toEqual({ missing: "username" });
		expect(textFor("type something", { a: "1", b: "2" })).toEqual({ missing: "text" });
	});
	test("isRisky matches the risky verbs as whole words only", () => {
		expect(isRisky({ role: "button", label: "Send" })).toBe(true);
		expect(isRisky({ role: "button", label: "Sign out" })).toBe(true);
		expect(isRisky({ role: "a", label: "Sender settings" })).toBe(false);
		expect(isRisky({ role: "button", label: "Sign in" })).toBe(false);
	});
	test("positionHint and optionLine", () => {
		expect(positionHint({ x: 900, y: 10, w: 50, h: 20 }, 1000, 800)).toBe("top-right");
		expect(positionHint({ x: 450, y: 400, w: 50, h: 20 }, 1000, 800)).toBe("middle-centre");
		expect(optionLine(el(0, "button", "  Sign   in  ", 450, 700), 1000, 800)).toBe(
			'button "Sign in" bottom-centre',
		);
		expect(optionLine(el(0, "input", "", 0, 0), 1000, 800)).toBe('input "(no label)" top-left');
	});
});

describe("adapters", () => {
	test("fromDomElements keeps the browser index and falls back to the href", () => {
		const out = fromDomElements([
			{
				index: 4,
				tag: "a",
				text: "",
				href: "/docs/install?x=1",
				rect: { x: 1, y: 2, w: 3, h: 4 },
				visible: true,
			},
			{ index: 5, tag: "button", text: "Go", rect: { x: 0, y: 0, w: 1, h: 1 }, visible: false },
		]);
		expect(out[0]).toEqual({
			index: 4,
			role: "a",
			label: "link to install",
			rect: { x: 1, y: 2, w: 3, h: 4 },
			visible: true,
		});
		expect(out[1].visible).toBe(false);
	});
	test("fromAxElements maps bbox and keeps the AX id", () => {
		const out = fromAxElements([
			{
				id: "ax-7",
				role: "AXButton",
				label: "OK",
				bbox: { x: 1, y: 2, width: 30, height: 40 },
				enabled: false,
			},
		]);
		expect(out[0]).toEqual({
			index: 0,
			id: "ax-7",
			role: "AXButton",
			label: "OK",
			rect: { x: 1, y: 2, w: 30, h: 40 },
			enabled: false,
		});
	});
});
