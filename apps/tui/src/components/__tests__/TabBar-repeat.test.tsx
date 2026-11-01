/**
 * Tabs that share a title carry the source tag once, not on every repeat, so
 * nine tabs still fit 100 columns without a "+N" cell hiding two of them.
 */
import { expect, test } from "bun:test";
import { renderToString } from "ink";
import React from "react";
import type { WorkspaceTab } from "../../hooks/useWorkspaceTabs.js";
import { TabBar } from "../TabBar.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const mk = (i: number, type: string, title: string, active = false) =>
	({
		id: `t${i}`,
		type,
		title,
		active,
		createdAt: "",
		lastAccessedAt: "",
		pinned: false,
		data: {},
	}) as unknown as WorkspaceTab;
const titles = [
	"Chat 1",
	"Notes",
	"Ideas",
	"Control",
	"Terminal",
	"Settings",
	"Pi (pi-mono)",
	"Pi (pi-mono)",
	"Pi (pi-mono)",
];
const tabs = titles.map((t, i) => mk(i, i < 6 ? "notes" : "chat", t, i === 7));

test("repeated titles drop the tag and all nine tabs fit 100 columns", () => {
	const out = strip(
		renderToString(<TabBar width={100} tabs={tabs} onSwitch={() => {}} />, { columns: 100 }),
	);
	const row = out.split("\n")[0] ?? "";
	expect(row).toContain("9] Pi");
	expect(row).not.toContain("pi-mono");
	expect(row).not.toMatch(/\+\d/);
	expect(row.length).toBeLessThanOrEqual(100);
});

test("a title that is not repeated keeps its tag", () => {
	const one = tabs.map((t, i) =>
		i === 6 ? { ...t, title: "Pi (pi-mono)" } : i > 6 ? { ...t, title: `Other ${i}` } : t,
	);
	const out = strip(
		renderToString(<TabBar width={160} tabs={one} onSwitch={() => {}} />, { columns: 160 }),
	);
	expect(out).toContain("7] Pi (pi-mono)");
});

test("40 columns still shows every tab number and the active title", () => {
	const out = strip(
		renderToString(<TabBar width={40} tabs={tabs} onSwitch={() => {}} />, { columns: 40 }),
	);
	const row = out.split("\n")[0] ?? "";
	expect(row).toContain("[8 Pi]");
	expect(row).toContain("9");
	expect(row.length).toBeLessThanOrEqual(40);
});

test("40 columns: inactive tabs keep their first letters so they can be told apart", () => {
	const out = strip(
		renderToString(<TabBar width={40} tabs={tabs} onSwitch={() => {}} />, { columns: 40 }),
	);
	const row = out.split("\n")[0] ?? "";
	expect(row).toContain("1Ch 2No 3Id 4Co 5Te 6Se");
	expect(row.length).toBeLessThanOrEqual(40);
});

test("40 columns: an emoji title is kept whole or dropped, never split into a broken character", () => {
	const many = [
		"\u{1F600}Smile",
		"Notes",
		"\u{1F468}\u200D\u{1F469}\u200D\u{1F467} Family",
		"\u00DCn\u00EF",
		"Chat",
		"Notes",
		"Ideas",
		"Control",
		"Terminal",
	].map((t, i) => mk(i, "chat", t, i === 7));
	const emoji = many;
	const out = strip(
		renderToString(<TabBar width={40} tabs={emoji} onSwitch={() => {}} />, { columns: 40 }),
	);
	const row = out.split("\n")[0] ?? "";
	expect(row.isWellFormed()).toBe(true);
	expect(row).toContain("1\u{1F600}");
});

test("40 columns: a long active title is cut with an ellipsis so every tab number stays", () => {
	const long = [
		"Chat 1",
		"Fix flaky websocket reconnect test in daemon package",
		"Notes",
		"Ideas",
	].map((t, i) => mk(i, "chat", t, i === 1));
	const out = strip(
		renderToString(<TabBar width={40} tabs={long} onSwitch={() => {}} />, { columns: 40 }),
	);
	const row = out.split("\n")[0] ?? "";
	expect(row).toContain("[2 Fix");
	expect(row).toContain("…]");
	expect(row).toMatch(/1 .*\] 3 4$/);
	expect(row.length).toBeLessThanOrEqual(40);
});

test("a grabbed tab keeps every tab on a narrow bar and the hint takes one row", () => {
	const four = [
		mk(0, "chat", "Orchestrator", true),
		mk(1, "chat", "Engineer"),
		mk(2, "chat", "QA"),
		mk(3, "chat", "Notes"),
	];
	for (const w of [60, 40]) {
		const out = strip(
			renderToString(<TabBar width={w} tabs={four} onSwitch={() => {}} grabbedTabId="t1" />, {
				columns: w,
			}),
		);
		const rows = out.split("\n");
		expect(rows.length).toBe(3);
		expect(rows[0]).toMatch(/2/);
		expect(rows[0]).toMatch(/3/);
		expect(rows[0]).toMatch(/4/);
		expect(rows[1]).toContain("[Esc] cancel");
		for (const r of rows) expect(r.length).toBeLessThanOrEqual(w);
	}
});

test("a bar the full layout overflows goes compact, so no tab folds into +N at 60 to 100 columns", () => {
	const eight = [
		"Chat 1",
		"Chat 2",
		"Chat 3",
		"Notes",
		"Questions",
		"Projects",
		"Terminal",
		"Settings",
	].map((t, i) => mk(i, "notes", t, i === 2));
	for (const w of [60, 80, 100]) {
		const out = strip(
			renderToString(<TabBar width={w} tabs={eight} onSwitch={() => {}} />, { columns: w }),
		);
		expect(out).not.toContain("+");
		expect(out).toContain("8Sett");
		expect(out.split("\n")[0]?.length).toBeLessThanOrEqual(w);
	}
});
