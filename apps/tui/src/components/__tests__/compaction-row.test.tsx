/**
 * The compaction row in the chat (#4958), through real Ink at 100x32, 52x30
 * and 40x24: two lines collapsed, the summary open on a tap, nothing wider
 * than the screen, the row estimate equal to what is drawn, and the app wired
 * to the engine's onCompaction event.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "ink";
import type { Message } from "../../app.js";
import { clearTargets, hitTest } from "../../lib/click-targets.js";
import { compactionLines, compactionRows } from "../../lib/compaction-view.js";
import { MessageList, estimateMessageRowsForTest } from "../message-list.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

class FakeStdin extends EventEmitter {
	isTTY = true;
	setRawMode() {}
	setEncoding() {}
	ref() {}
	unref() {}
	read(): string | null {
		return null;
	}
}

const mounted: Array<() => void> = [];
afterEach(() => {
	for (const u of mounted.splice(0)) u();
	clearTargets();
});

const summary =
	"## Goal\nFix the tie-break in score.ts\n\n## Progress\nDone: reproduced the failure.";
const row = (expanded: boolean): Message => ({
	id: "c1",
	role: "system",
	content: "Compacted",
	timestamp: new Date(0),
	compaction: {
		tokensBefore: 41000,
		tokensAfter: 9000,
		messagesRemoved: 27,
		summary,
		filesRead: ["score.ts"],
		filesModified: ["score.test.ts"],
		expanded,
	},
});
const user: Message = { id: "u1", role: "user", content: "fix it", timestamp: new Date(0) };

function mount(cols: number, rows: number, messages: Message[], onToggle = () => {}) {
	const out = new EventEmitter() as EventEmitter & {
		columns: number;
		rows: number;
		isTTY: boolean;
		last: string;
		write: (s: string) => boolean;
	};
	out.columns = cols;
	out.rows = rows;
	out.isTTY = false;
	out.last = "";
	out.write = (s) => {
		const f = strip(s);
		if (f.trim()) out.last = f;
		return true;
	};
	const calls: string[] = [];
	const el = (msgs: Message[]) => (
		<MessageList
			messages={msgs}
			animateTyping={false}
			showAnimations={false}
			turnRunning={false}
			contentWidth={cols - 4}
			rowBudget={rows}
			onToggleCompaction={(id) => {
				calls.push(id);
				onToggle();
			}}
		/>
	);
	const app = render(el(messages), {
		stdout: out as unknown as NodeJS.WriteStream,
		stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
		debug: true,
		patchConsole: false,
		exitOnCtrlC: false,
	});
	mounted.push(() => app.unmount());
	return {
		lines: () => out.last.replace(/\n+$/, "").split("\n"),
		calls,
		set: (m: Message[]) => app.rerender(el(m)),
	};
}

describe("collapsed", () => {
	for (const [cols, rows] of [
		[100, 32],
		[52, 30],
		[40, 24],
	] as const) {
		test(`${cols}x${rows}: the headline and a how-to line, inside the screen`, async () => {
			const m = mount(cols, rows, [user, row(false)]);
			await sleep(60);
			const ls = m.lines();
			for (const l of ls) expect([...l].length).toBeLessThanOrEqual(cols);
			const i = ls.findIndex((l) =>
				l.includes(cols < 44 ? "Compacted 41k to 9k tokens" : "Compacted from 41k to 9k tokens"),
			);
			expect(i).toBeGreaterThanOrEqual(0);
			expect(ls[i]).toContain("▸");
			expect(ls[i + 1]).toContain("/compact");
		});
	}
});

describe("expanded", () => {
	test("52 columns: the summary and the files are on screen, and a fold hint ends the row", async () => {
		const m = mount(52, 30, [user, row(true)]);
		await sleep(60);
		const text = m.lines().join("\n");
		expect(text).toContain("▾ Compacted from 41k to 9k tokens");
		expect(text).toContain("Fix the tie-break in score.ts");
		expect(text).toContain("modified: score.test.ts");
		expect(text).toContain("fold");
	});

	test("the row estimate equals the rows the row takes", () => {
		for (const expanded of [false, true]) {
			const n = row(expanded).compaction!;
			for (const w of [36, 48, 96]) {
				expect(estimateMessageRowsForTest(row(expanded), w)).toBe(compactionRows(n, w));
				expect(compactionRows(n, w)).toBe(compactionLines(n, w).length + 1);
			}
		}
	});
});

describe("tap", () => {
	test("a tap anywhere on the row asks to toggle that row; the second line counts", async () => {
		const m = mount(52, 30, [user, row(false)]);
		await sleep(60);
		// Find the headline's screen position from the frame: the row is the tap target.
		const y = m.lines().findIndex((l) => l.includes("Compacted from"));
		expect(y).toBeGreaterThanOrEqual(0);
		const head = hitTest(6, y);
		expect(head?.id).toBe("compaction:c1");
		head?.action();
		expect(m.calls).toEqual(["c1"]);
		hitTest(6, y + 1)?.action();
		expect(m.calls).toEqual(["c1", "c1"]);
	});

	test("opening it again with the row expanded redraws taller, then folds", async () => {
		const m = mount(52, 30, [user, row(false)]);
		await sleep(60);
		const before = m.lines().length;
		m.set([user, row(true)]);
		await sleep(60);
		expect(m.lines().length).toBeGreaterThan(before);
		m.set([user, row(false)]);
		await sleep(60);
		expect(m.lines().join("\n")).not.toContain("Fix the tie-break");
	});
});

describe("wiring", () => {
	const app = readFileSync(join(import.meta.dir, "..", "..", "app.tsx"), "utf8");
	const agent = readFileSync(
		join(import.meta.dir, "..", "..", "..", "..", "..", "packages", "eight", "agent.ts"),
		"utf8",
	);
	test("the app turns the engine's onCompaction event into a row in the compacting tab", () => {
		expect(app).toContain("onCompaction: (r) => {");
		expect(app).toContain("appendToTabLatest.current(tabId, {");
		expect(app).toContain("compaction: {");
	});
	test("/compact runs the engine, /compact show toggles, /compact undo restores", () => {
		expect(app).toContain("agent.compactNow()");
		expect(app).toContain("agent.undoCompaction()");
		expect(app).toContain("toggleCompaction(null)");
		// The old behaviour is gone: no silent keep-the-last-4 trim.
		expect(app).not.toContain("Context trimmed");
	});
	test("the agent keeps the history before each compaction, automatic or asked", () => {
		expect(agent).toContain("this.compactionUndo.remember(this.messageHistory, pass.entryId)");
		expect((agent.match(/compactionUndo\.remember\(/g) ?? []).length).toBe(2);
	});
});
