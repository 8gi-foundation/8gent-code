/**
 * TabBar tests (issue #2913).
 *
 * The live 120x40 frame rendered
 *   `] >> Orchestrator  ]] >> Engineer  ]]┌ >> QA ┐] N: Notes  ]] =: Settings  [G] drop on another tab...`
 * because an omitted `grabbedTabId` (undefined) passed the `!== null`
 * drag-mode check, and the active tab's bottom bracket was four columns
 * wider than its top. Both rows must now be exactly `width` columns and
 * the active tab's corners must line up.
 */

import { describe, expect, test } from "bun:test";
import type React from "react";
import { TAB_ICONS, type WorkspaceTab } from "../../hooks/useWorkspaceTabs";
import { GRAB_HINT, TabBar, buildTabRows } from "../TabBar";
import { renderInk } from "./ink-harness";

function tab(id: string, type: WorkspaceTab["type"], title: string, active = false): WorkspaceTab {
	const now = new Date().toISOString();
	return {
		id,
		type,
		title,
		active,
		createdAt: now,
		lastAccessedAt: now,
		pinned: false,
		data: {},
	};
}

const TABS: WorkspaceTab[] = [
	tab("t1", "chat", "Orchestrator"),
	tab("t2", "chat", "Engineer"),
	tab("t3", "chat", "QA", true),
	tab("t4", "notes", "Notes"),
	tab("t5", "settings", "Settings"),
];

function flatten(node: unknown): string {
	if (node == null || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(flatten).join("");
	if (typeof node === "object" && "props" in (node as { props?: unknown })) {
		const el = node as { props: { children?: unknown } };
		return flatten(el.props.children);
	}
	return "";
}

function invoke(props: Parameters<typeof TabBar>[0]): React.ReactElement | null {
	return (TabBar as (p: Parameters<typeof TabBar>[0]) => React.ReactElement | null)(props);
}

describe("buildTabRows geometry", () => {
	test("both rows are exactly the requested width", () => {
		for (const width of [80, 100, 120]) {
			const { top, bottom } = buildTabRows(
				[
					{ label: ">> Orchestrator", active: false },
					{ label: ">> QA", active: true },
					{ label: "N: Notes", active: false },
				],
				width,
			);
			expect(top.length).toBe(width);
			expect(bottom.length).toBe(width);
		}
	});

	test("active tab corners line up: ┘ under ┌ and └ under ┐", () => {
		const { top, bottom } = buildTabRows(
			[
				{ label: ">> Orchestrator", active: false },
				{ label: ">> QA", active: true },
				{ label: "N: Notes", active: false },
			],
			80,
		);
		expect(bottom.indexOf("┘")).toBe(top.indexOf("┌"));
		expect(bottom.indexOf("└")).toBe(top.indexOf("┐"));
	});

	test("no square brackets unless a tab is grabbed", () => {
		const { top, bottom } = buildTabRows(
			[
				{ label: ">> A", active: true },
				{ label: ">> B", active: false },
			],
			60,
		);
		expect(top).not.toMatch(/[[\]]/);
		expect(bottom).not.toMatch(/[[\]]/);
	});

	test("a grabbed tab is bracketed and the hint sits flush right", () => {
		const hint = ` ${GRAB_HINT}`;
		const { top } = buildTabRows(
			[
				{ label: ">> A", active: false, grabbed: true },
				{ label: ">> B", active: true },
			],
			120,
			hint,
		);
		expect(top.length).toBe(120);
		expect(top.startsWith("[>> A]")).toBe(true);
		expect(top.endsWith(hint)).toBe(true);
	});

	test("overflowing tabs are truncated with an ellipsis, never wrapped", () => {
		const cells = Array.from({ length: 12 }, (_, i) => ({
			label: `>> Very long tab title ${i}`,
			active: i === 0,
		}));
		const { top, bottom } = buildTabRows(cells, 100);
		expect(top.length).toBe(100);
		expect(bottom.length).toBe(100);
		expect(top.endsWith("…")).toBe(true);
	});
});

describe("TabBar", () => {
	test("returns null for a single tab", () => {
		expect(invoke({ tabs: [tab("only", "chat", "Chat", true)], onSwitch: () => {} })).toBeNull();
	});

	test("renders without stray ] or ]] glyphs when grabbedTabId is omitted", () => {
		const rendered = invoke({ tabs: TABS, onSwitch: () => {}, width: 120 });
		const text = flatten(rendered);
		expect(text).not.toContain("]");
		expect(text).not.toContain("[");
		expect(text).not.toContain(GRAB_HINT);
		expect(text).toContain("┌ >> QA ┐");
	});

	test("laid out by Ink at 120 and 100 columns, no line exceeds the width", async () => {
		for (const columns of [120, 100]) {
			const h = renderInk(<TabBar tabs={TABS} onSwitch={() => {}} width={columns} />, {
				columns,
				rows: 40,
			});
			await h.settle();
			const lines = h.frame().split("\n").filter((l) => l.length > 0);
			expect(lines.length).toBe(2);
			for (const line of lines) {
				expect(line.length).toBeLessThanOrEqual(columns);
				expect(line).not.toMatch(/[[\]]/);
			}
			// Bottom row is a continuous rule with one gap under the active tab.
			expect(lines[1]).toMatch(/^─+┘ +└─+$/);
			h.unmount();
		}
	});
});

describe("tab icons", () => {
	test("the Settings icon no longer reads like a hotkey", () => {
		const settings = TAB_ICONS.find((i) => i.type === "settings");
		expect(settings).toBeDefined();
		expect(settings?.icon).not.toBe("=:");
		expect(settings?.icon).toBe("§");
	});
});
