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
