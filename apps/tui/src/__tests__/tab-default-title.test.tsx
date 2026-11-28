/**
 * A new chat tab is titled "Chat", not "Chat N". The tab bar already numbers
 * every tab, so "5 Chat 4" read as two numbers that disagreed.
 */
import { expect, test } from "bun:test";
import { renderToString } from "ink";
import React from "react";
import { TabBar } from "../components/TabBar.js";
import { type WorkspaceTab, defaultTabTitle } from "../hooks/useWorkspaceTabs.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

test("a new chat tab is titled Chat, whatever its position", () => {
	expect(defaultTabTitle("chat")).toBe("Chat");
	expect(defaultTabTitle("chat")).not.toMatch(/\d/);
});

test("non-chat tabs keep their own label", () => {
	expect(defaultTabTitle("notes")).toBe("Notes");
	expect(defaultTabTitle("ideas")).toBe("Ideas");
});

test("the tab bar numbers three new chat tabs, with no second number in any title", () => {
	const mk = (i: number, title: string, active = false) =>
		({
			id: `t${i}`,
			type: "chat",
			title,
			active,
			createdAt: "",
			lastAccessedAt: "",
			pinned: false,
			data: {},
		}) as unknown as WorkspaceTab;
	// The titles come from the same helper the app uses for a new chat tab.
	const fresh = defaultTabTitle("chat");
	const tabs = [mk(0, fresh), mk(1, fresh), mk(2, fresh, true)];
	const row =
		strip(
			renderToString(<TabBar width={100} tabs={tabs} onSwitch={() => {}} />, { columns: 100 }),
		).split("\n")[0] ?? "";
	expect(row).toContain("1] Chat");
	expect(row).toContain("2] Chat");
	expect(row).toContain("3] Chat");
	expect(row).not.toMatch(/Chat \d/);
});
