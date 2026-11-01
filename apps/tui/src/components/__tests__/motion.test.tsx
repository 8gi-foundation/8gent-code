/**
 * HUD motion language (MOTION.md): tab underline sweep, figure-8 settling
 * into DONE, and trail rows landing in turn. Pure timing is tested directly;
 * the components are rendered through real Ink into a fake terminal and
 * sampled over time.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Text, render } from "ink";
import { useEffect, useState } from "react";
import type { WorkspaceTab } from "../../hooks/useWorkspaceTabs.js";
import { FIGURE_EIGHT_STILL } from "../../lib/figure-eight.js";
import {
	MOTION_BUDGET_MS,
	SETTLE_HOLD_MS,
	SWEEP_EASE,
	SWEEP_FRAME_MS,
	motionEnabled,
	reducedMotionFromEnv,
	staggerFor,
	sweepFrames,
} from "../../lib/motion.js";
import { isTurnDone, TurnStateLabel } from "../LiveFocalStrip.js";
import { TabBar, layoutTabs, ruleRow } from "../TabBar.js";
import { useLandingRows } from "../ToolTrail.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

function fakeStdout(cols = 80, rows = 24) {
	const out = new EventEmitter() as EventEmitter & {
		columns: number;
		rows: number;
		isTTY: boolean;
		frames: string[];
		write: (s: string) => boolean;
	};
	out.columns = cols;
	out.rows = rows;
	out.isTTY = false;
	out.frames = [];
	out.write = (s: string) => {
		out.frames.push(strip(s));
		return true;
	};
	return out;
}

function mount(node: React.ReactElement, cols = 80) {
	const stdout = fakeStdout(cols);
	const app = render(node, {
		stdout: stdout as unknown as NodeJS.WriteStream,
		debug: true,
		patchConsole: false,
		exitOnCtrlC: false,
	});
	return { stdout, app, last: () => stdout.frames.at(-1) ?? "" };
}

describe("motion timing", () => {
	test("the sweep ends exactly on the target and inside the budget", () => {
		const frames = sweepFrames({ x: 3, width: 12 }, { x: 36, width: 5 });
		expect(frames.at(-1)).toEqual({ x: 36, width: 5 });
		expect(frames.length).toBe(SWEEP_EASE.length);
		expect((frames.length - 1) * SWEEP_FRAME_MS).toBeLessThan(MOTION_BUDGET_MS);
		// Monotonic: the bar never overshoots or steps back.
		for (let i = 1; i < frames.length; i++) {
			expect(frames[i]!.x).toBeGreaterThanOrEqual(frames[i - 1]!.x);
		}
	});

	test("stagger keeps any batch inside the budget", () => {
		expect(staggerFor(1)).toBe(0);
		expect(staggerFor(3)).toBe(80);
		expect(staggerFor(20) * 19).toBeLessThanOrEqual(MOTION_BUDGET_MS);
	});

	test("the settle beat is inside the budget", () => {
		expect(SETTLE_HOLD_MS).toBeLessThan(MOTION_BUDGET_MS);
	});

	test("Ctrl+A and reduced motion both switch motion off", () => {
		expect(motionEnabled(true, {})).toBe(true);
		expect(motionEnabled(false, {})).toBe(false);
		expect(motionEnabled(true, { "8GENT_REDUCED_MOTION": "1" })).toBe(false);
		expect(reducedMotionFromEnv({})).toBe(false);
	});
});

describe("tab bar", () => {
	test("layout puts each title after its number and records its span", () => {
		const line = layoutTabs([
			{ num: "1] ", title: "Orchestrator", active: true },
			{ num: "2] ", title: "QA", active: false },
		]);
		expect(line.text).toBe("1] Orchestrator   2] QA");
		expect(line.text.slice(line.spans[1]!.x, line.spans[1]!.x + 2)).toBe("QA");
	});

	test("the rule row is exactly the width, bar where asked", () => {
		const r = ruleRow(20, { x: 3, width: 4 });
		expect((r.before + r.bar + r.after).length).toBe(20);
		expect(r.bar).toBe("━━━━");
		expect(r.before.length).toBe(3);
		const clipped = ruleRow(10, { x: 8, width: 6 });
		expect((clipped.before + clipped.bar + clipped.after).length).toBe(10);
	});

	function tabs(active: number): WorkspaceTab[] {
		return ["Orchestrator", "Engineer", "QA"].map((title, i) => ({
			id: `t${i}`,
			type: "chat",
			title,
			active: i === active,
			createdAt: "",
			lastActiveAt: "",
		})) as unknown as WorkspaceTab[];
	}

	function Switcher({ animate }: { animate: boolean }) {
		const [active, setActive] = useState(0);
		useEffect(() => {
			const id = setTimeout(() => setActive(2), 20);
			return () => clearTimeout(id);
		}, []);
		return <TabBar tabs={tabs(active)} onSwitch={() => {}} animate={animate} />;
	}

	const barStart = (frame: string) => (frame.split("\n")[1] ?? "").indexOf("━");

	test("switching tabs sweeps the bar through in-between columns", async () => {
		const { stdout, app } = mount(<Switcher animate />);
		await sleep(400);
		app.unmount();
		const starts = [...new Set(stdout.frames.filter((f) => f.includes("━")).map(barStart))];
		const qa = "1] Orchestrator   2] Engineer   3] ".length;
		expect(starts[0]).toBe(3);
		expect(starts.at(-1)).toBe(qa);
		// At least two in-between positions: a sweep, not a jump.
		expect(starts.filter((x) => x > 3 && x < qa).length).toBeGreaterThanOrEqual(2);
		// No drop hint unless a tab is grabbed.
		expect(stdout.frames.at(-1)).not.toContain("[G]");
	});

	test("with animations off the bar jumps", async () => {
		const { stdout, app } = mount(<Switcher animate={false} />);
		await sleep(300);
		app.unmount();
		const starts = [...new Set(stdout.frames.filter((f) => f.includes("━")).map(barStart))];
		expect(starts).toEqual([3, "1] Orchestrator   2] Engineer   3] ".length]);
	});
});

describe("turn settles into DONE", () => {
	test("DONE only after a clean end, never while running", () => {
		expect(isTurnDone(false, 1, true)).toBe(true);
		expect(isTurnDone(true, 1, true)).toBe(false);
		expect(isTurnDone(false, 1, false)).toBe(false);
		expect(isTurnDone(false, null, null)).toBe(false);
	});

	function Turn({ animate }: { animate: boolean }) {
		const [end, setEnd] = useState<number | null>(null);
		useEffect(() => {
			const id = setTimeout(() => setEnd(1000), 60);
			return () => clearTimeout(id);
		}, []);
		const running = end === null;
		return (
			<TurnStateLabel
				isProcessing={running}
				lastTurnEndedAt={end}
				done={isTurnDone(running, end, end === null ? null : true)}
				animate={animate}
			/>
		);
	}

	test("the spinner holds still, then resolves to DONE without a flash", async () => {
		const { stdout, app } = mount(<Turn animate />);
		await sleep(60 + SETTLE_HOLD_MS + 150);
		app.unmount();
		const seq = stdout.frames.map((f) => (f.includes("DONE") ? "done" : f.includes(FIGURE_EIGHT_STILL) && f.includes("NOW") ? "still" : "now"));
		const firstDone = seq.indexOf("done");
		expect(firstDone).toBeGreaterThan(0);
		expect(seq.slice(0, firstDone)).toContain("still");
		// Once DONE, it stays DONE.
		expect(seq.slice(firstDone).every((s) => s === "done")).toBe(true);
	});

	test("with animations off it goes straight to DONE", async () => {
		const { last, app } = mount(<Turn animate={false} />);
		await sleep(100);
		app.unmount();
		expect(last()).toContain("DONE");
	});
});

describe("trail rows land in turn", () => {
	function Rows({ animate, batch }: { animate: boolean; batch: number }) {
		const [total, setTotal] = useState(1);
		useEffect(() => {
			const id = setTimeout(() => setTotal(1 + batch), 20);
			return () => clearTimeout(id);
		}, [batch]);
		const n = useLandingRows(total, animate);
		return <Text>{`rows=${n}`}</Text>;
	}

	const counts = (frames: string[]) =>
		frames.map((f) => Number(/rows=(\d+)/.exec(f)?.[1] ?? -1)).filter((n) => n >= 0);

	test("a batch of three lands one at a time and never goes backwards", async () => {
		const { stdout, app } = mount(<Rows animate batch={3} />);
		await sleep(400);
		app.unmount();
		const seen = counts(stdout.frames);
		expect(seen.at(-1)).toBe(4);
		expect(new Set(seen)).toEqual(new Set([1, 2, 3, 4]));
		for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
	});

	test("one new row shows at once", async () => {
		const { stdout, app } = mount(<Rows animate batch={1} />);
		await sleep(100);
		app.unmount();
		expect(new Set(counts(stdout.frames))).toEqual(new Set([1, 2]));
	});

	test("with animations off a batch shows at once", async () => {
		const { stdout, app } = mount(<Rows animate={false} batch={3} />);
		await sleep(100);
		app.unmount();
		expect(new Set(counts(stdout.frames))).toEqual(new Set([1, 4]));
	});
});
