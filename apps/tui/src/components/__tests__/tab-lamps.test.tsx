/**
 * Tab lamps (#4928), rendered: a background tab that hits an approval shows
 * ▲ on the bar in the very next render, done and failed play once and rest,
 * every label stays readable at 40 and 80 columns, and no timer outlives a
 * motion.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { render } from "ink";
import type { WorkspaceTab } from "../../hooks/useWorkspaceTabs.js";
import { MOTION_BUDGET_MS } from "../../lib/motion.js";
import type { LampInput } from "../../lib/tab-lamps.js";
import { TabBar, type TabCell, _lampTimersLive, fitTabCells } from "../TabBar.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

function fakeStdout(cols: number) {
	const out = new EventEmitter() as EventEmitter & {
		columns: number;
		rows: number;
		isTTY: boolean;
		frames: string[];
		write: (s: string) => boolean;
	};
	out.columns = cols;
	out.rows = 24;
	out.isTTY = false;
	out.frames = [];
	out.write = (s: string) => {
		out.frames.push(strip(s));
		return true;
	};
	return out;
}

const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount();
});

type Flags = Record<string, Pick<LampInput, "needsYou" | "unread">>;

function makeTabs(titles: string[], active = 0): WorkspaceTab[] {
	return titles.map((title, i) => ({
		id: `t${i}`,
		type: "chat",
		title,
		active: i === active,
		createdAt: "",
		lastActiveAt: "",
	})) as unknown as WorkspaceTab[];
}

function mount(cols: number) {
	const stdout = fakeStdout(cols);
	const app = render(<span />, {
		stdout: stdout as unknown as NodeJS.WriteStream,
		debug: true,
		patchConsole: false,
		exitOnCtrlC: false,
	});
	mounted.push(app);
	const show = (
		titles: string[],
		opts: { active?: number; flags?: Flags; busy?: string[]; animate?: boolean } = {},
	) => {
		app.rerender(
			<TabBar
				tabs={makeTabs(titles, opts.active ?? 0)}
				onSwitch={() => {}}
				isTabProcessing={(id) => (opts.busy ?? []).includes(id)}
				lampFor={(id) => opts.flags?.[id]}
				animate={opts.animate ?? true}
				width={cols}
			/>,
		);
	};
	const last = () => stdout.frames.at(-1) ?? "";
	return { show, last, stdout };
}

const TITLES = ["Orchestrator", "Engineer", "QA", "Notes"];
const FIVE = ["Orchestrator", "Engineer", "QA", "Notes", "Docs"];

describe("tab lamps in the bar", () => {
	test("a background tab that hits an approval shows ▲ in the next render", async () => {
		const m = mount(80);
		m.show(TITLES, { busy: ["t2"] });
		await sleep(30);
		expect(m.last()).toContain("QA ◐");
		const before = m.stdout.frames.length;
		m.show(TITLES, { busy: ["t2"], flags: { t2: { needsYou: true, unread: null } } });
		// One render, no timers waited on.
		const frame = m.stdout.frames[before] ?? "";
		expect(frame).toContain("QA ▲");
		expect(frame).not.toContain("QA ◐");
		await sleep(150);
		expect(m.last()).toContain("QA ▲");
	});

	test("with animation off the lamp lands at once and no timer is made", async () => {
		const m = mount(80);
		m.show(TITLES, { animate: false });
		const before = m.stdout.frames.length;
		m.show(TITLES, { animate: false, flags: { t3: { needsYou: false, unread: "done" } } });
		expect(m.stdout.frames[before] ?? "").toContain("Notes ●");
		expect(_lampTimersLive()).toBe(0);
	});

	test("done: the fill completes inside the budget, then the lamp rests", async () => {
		const m = mount(80);
		m.show(TITLES, { busy: ["t1"] });
		await sleep(30);
		m.show(TITLES, { flags: { t1: { needsYou: false, unread: "done" } } });
		await sleep(MOTION_BUDGET_MS);
		expect(m.last()).toContain("Engineer ●");
		const settled = m.stdout.frames.length;
		await sleep(250);
		expect(m.stdout.frames.length).toBe(settled);
		expect(_lampTimersLive()).toBe(0);
	});

	test("failed: shows the cross and rests on it", async () => {
		const m = mount(80);
		m.show(TITLES, { busy: ["t1"] });
		await sleep(30);
		m.show(TITLES, { flags: { t1: { needsYou: false, unread: "failed" } } });
		await sleep(MOTION_BUDGET_MS);
		expect(m.last()).toContain("Engineer ✕");
		expect(_lampTimersLive()).toBe(0);
	});

	test("visiting a done tab holds its lamp 120 ms, then drops to idle", async () => {
		const m = mount(80);
		m.show(TITLES, { flags: { t1: { needsYou: false, unread: "done" } } });
		await sleep(30);
		expect(m.last()).toContain("Engineer ●");
		m.show(TITLES, { active: 1 });
		expect(m.last()).toContain("Engineer ●");
		await sleep(60);
		expect(m.last()).toContain("Engineer ●");
		await sleep(160);
		expect(m.last()).toContain("Engineer ·");
		expect(_lampTimersLive()).toBe(0);
	});

	test("nothing loops: after a burst of changes the timer count is zero", async () => {
		const m = mount(80);
		m.show(TITLES);
		m.show(TITLES, { busy: ["t0", "t1"] });
		m.show(TITLES, { busy: ["t0"], flags: { t1: { needsYou: false, unread: "done" } } });
		m.show(TITLES, { flags: { t0: { needsYou: true, unread: null } } });
		await sleep(MOTION_BUDGET_MS + 100);
		expect(_lampTimersLive()).toBe(0);
		const settled = m.stdout.frames.length;
		await sleep(300);
		expect(m.stdout.frames.length).toBe(settled);
	});

	test("unmounting mid-motion releases the timers", async () => {
		const m = mount(80);
		m.show(TITLES);
		m.show(TITLES, { flags: { t2: { needsYou: false, unread: "done" } } });
		await sleep(10);
		mounted.splice(0).forEach((x) => x.unmount());
		expect(_lampTimersLive()).toBe(0);
	});

	test("80 columns: every title and its lamp are readable, all five states", () => {
		const m = mount(80);
		m.show(FIVE, {
			active: 0,
			busy: ["t0"],
			animate: false,
			flags: {
				t2: { needsYou: true, unread: null },
				t3: { needsYou: false, unread: "done" },
				t4: { needsYou: false, unread: "failed" },
			},
		});
		const out = m.last();
		for (const s of ["1] Orchestrator ◐", "2] Engineer ·", "3] QA ▲", "4] Notes ●", "5] Docs ✕"]) {
			expect(out).toContain(s);
		}
	});

	test("40 columns: titles give way, lamps never do, the active tab keeps its title", () => {
		const m = mount(40);
		m.show(FIVE, {
			active: 0,
			busy: ["t0"],
			animate: false,
			flags: {
				t2: { needsYou: true, unread: null },
				t3: { needsYou: false, unread: "done" },
				t4: { needsYou: false, unread: "failed" },
			},
		});
		const row = m.last().split("\n")[0] ?? "";
		expect(row).toContain("[1 Orchestrator ◐] 2· 3▲ 4● 5✕");
	});

	test("40 columns: the active tab's title is never cut for another's lamp", () => {
		const m = mount(40);
		m.show(FIVE, { active: 2, animate: false });
		const row = m.last().split("\n")[0] ?? "";
		expect(row).toContain("[3 QA ·]");
		expect(row).toContain("1·");
		expect(row).toContain("5·");
	});

	test("a screen reader gets each tab's state as words, not glyphs", () => {
		const stdout = fakeStdout(80);
		const app = render(
			<TabBar
				tabs={makeTabs(TITLES)}
				onSwitch={() => {}}
				isTabProcessing={(id) => id === "t0"}
				lampFor={(id) => (id === "t2" ? { needsYou: true, unread: null } : undefined)}
				animate={false}
				width={80}
			/>,
			{
				stdout: stdout as unknown as NodeJS.WriteStream,
				debug: true,
				patchConsole: false,
				exitOnCtrlC: false,
				isScreenReaderEnabled: true,
			},
		);
		mounted.push(app);
		const out = stdout.frames.at(-1) ?? "";
		expect(out).toContain(
			"Tabs: 1 Orchestrator working, 2 Engineer idle, 3 QA needs you, 4 Notes idle",
		);
		expect(out).not.toContain("▲");
	});
});

describe("overflow", () => {
	const cell = (n: number, active = false): TabCell => ({
		num: `${n}] `,
		title: `Tab-number-${n}`,
		active,
		lamp: "·",
	});

	test("cut tabs collapse into +N carrying the most urgent hidden lamp", () => {
		const cells = [1, 2, 3, 4, 5, 6].map((n) => cell(n, n === 1));
		const fitted = fitTabCells(cells, ["idle", "idle", "idle", "needs", "idle", "done"], 50);
		const last = fitted.cells.at(-1)!;
		expect(last.num).toMatch(/^\+\d+$/);
		expect(last.lamp).toBe("▲");
		expect(fitted.hidden).toContain(3);
		expect(fitted.hidden).not.toContain(0);
		expect(fitted.index.at(-1)).toBeNull();
	});

	test("nothing is cut when everything fits", () => {
		const cells = [1, 2].map((n) => cell(n, n === 1));
		const fitted = fitTabCells(cells, ["idle", "idle"], 80);
		expect(fitted.hidden).toEqual([]);
		expect(fitted.cells).toBe(cells);
	});

	test("ascii terminals get ascii lamps on the overflow cell", () => {
		const cells = [1, 2, 3, 4, 5, 6].map((n) => cell(n, n === 1));
		const fitted = fitTabCells(
			cells,
			["idle", "idle", "idle", "idle", "idle", "needs"],
			50,
			"   ",
			true,
		);
		expect(fitted.cells.at(-1)!.lamp).toBe("!");
	});
});
