/**
 * CommandPalette tests.
 *
 * Strategy: the stateful CommandPalette wrapper owns hooks (useState +
 * useInput) which can't be invoked outside an Ink render context. The
 * codebase has no ink-testing-library or react-test-renderer installed,
 * so we follow the same pattern as the other __tests__ in this folder
 * and target two pure surfaces:
 *
 *   - CommandPaletteView: stateless render, snapshot-able.
 *   - filterAndSortCommands: pure function, unit-testable.
 *
 * The wrapper itself is exercised via the export-shape assertion.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { stripAnsi } from "../../lib/text";
import {
	CommandPalette,
	CommandPaletteView,
	type CommandPaletteCommand,
	type CommandPaletteViewProps,
	computeWindow,
	filterAndSortCommands,
	paletteColumns,
} from "../CommandPalette";
import { ctrl, renderInk } from "./ink-harness";

const COMMANDS: CommandPaletteCommand[] = [
	{ name: "voice", description: "Voice TTS settings" },
	{ name: "kanban", description: "Toggle kanban board view" },
	{ name: "predict", description: "Show predicted next steps" },
	{ name: "voiceprint", description: "Speaker diarisation tools" },
	{ name: "model", description: "Select LLM model" },
];

function invokeView(props: CommandPaletteViewProps): React.ReactElement {
	return (CommandPaletteView as (
		p: CommandPaletteViewProps,
	) => React.ReactElement)(props);
}

describe("CommandPalette wrapper", () => {
	test("exports the component and accepts the documented prop shape", () => {
		expect(CommandPalette).toBeDefined();
		expect(typeof CommandPalette).toBe("function");

		// Build the element WITHOUT invoking the function. Verifies the
		// exported component is usable in JSX without throwing on prop typing.
		const element = React.createElement(CommandPalette, {
			isOpen: false,
			onClose: () => {},
			onExecute: () => {},
			commands: COMMANDS,
		});
		expect(element).toBeDefined();
		expect(element.type).toBe(CommandPalette);
	});
});

describe("CommandPaletteView", () => {
	test("renders bordered Box (open, empty query, all commands)", () => {
		const rendered = invokeView({
			query: "",
			activeIndex: 0,
			commands: COMMANDS,
		});

		const props = rendered.props as {
			borderStyle: string;
			width: number;
			flexDirection: string;
			flexShrink: number;
		};
		expect(props.borderStyle).toBe("round");
		expect(props.flexDirection).toBe("column");
		expect(props.width).toBe(50);
		expect(props.flexShrink).toBe(0);
	});

	test("snapshot matrix - empty query / filtered / no-match / cursor moved", () => {
		const matrix = [
			{
				label: "open with empty query, first active",
				query: "",
				activeIndex: 0,
				commands: COMMANDS,
			},
			{
				label: "open filter voice (prefix wins)",
				query: "voice",
				activeIndex: 0,
				commands: filterAndSortCommands(COMMANDS, "voice"),
			},
			{
				label: "open filter no match",
				query: "zzz",
				activeIndex: 0,
				commands: filterAndSortCommands(COMMANDS, "zzz"),
			},
			{
				label: "after arrow-down, second row active",
				query: "",
				activeIndex: 1,
				commands: COMMANDS,
			},
			{
				// The 120-column shell leaves a 27-column centre column (#2913).
				label: "narrow column (27 cols): one truncated entry per row",
				query: "",
				activeIndex: 0,
				commands: COMMANDS,
				width: 27,
			},
		].map((row) => {
			const rendered = invokeView({
				query: row.query,
				activeIndex: row.activeIndex,
				commands: row.commands,
				width: row.width,
			});
			const props = rendered.props as {
				borderStyle: string;
				width: number;
			};
			return {
				label: row.label,
				query: row.query,
				activeIndex: row.activeIndex,
				commandNames: row.commands.map((c) => c.name),
				borderStyle: props.borderStyle,
				width: props.width,
				...(row.width ? { rows: renderedRows(rendered) } : {}),
			};
		});

		expect(matrix).toMatchSnapshot();
	});
});

/** Text of each direct child row of the palette box. */
function renderedRows(node: React.ReactElement): string[] {
	const children = React.Children.toArray(
		(node.props as { children?: React.ReactNode }).children,
	);
	return children.map((child) => flattenText(child));
}

function flattenText(node: unknown): string {
	if (node == null || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(flattenText).join("");
	if (typeof node === "object" && "props" in (node as { props?: unknown })) {
		const el = node as { props: { children?: unknown } };
		return flattenText(el.props.children);
	}
	return "";
}

describe("palette sizing (issue #2913)", () => {
	const LONG: CommandPaletteCommand[] = [
		{
			name: "knowledge",
			description:
				"Personal knowledge base with RAG: ingest articles, tweets, videos, PDFs, then query with natural language using vector similarity.",
		},
		{ name: "settings", description: "Open settings view (toggle voice, performance, providers, models)" },
	];

	test("paletteColumns keeps name + description inside the inner width", () => {
		for (const width of [27, 40, 50, 61, 76]) {
			const cols = paletteColumns(width, LONG);
			expect(cols.inner).toBe(width - 4);
			// marker (2) + name + space + description never exceeds inner
			if (cols.description > 0) {
				expect(2 + cols.name + 1 + cols.description).toBeLessThanOrEqual(cols.inner);
			}
		}
	});

	test("paletteColumns drops the description rather than mangling it when tight", () => {
		const cols = paletteColumns(20, LONG);
		expect(cols.description).toBe(0);
		expect(cols.name).toBeGreaterThan(0);
	});

	test("every rendered row fits the inner width at 27 and 61 columns", () => {
		for (const width of [27, 61]) {
			const view = invokeView({ query: "", activeIndex: 0, commands: LONG, width });
			const rows = renderedRows(view);
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) {
				expect(row.length).toBeLessThanOrEqual(width - 4);
			}
			// One entry per row: both names present, each on its own row.
			expect(rows.filter((r) => r.includes("/knowledge")).length).toBe(1);
			expect(rows.filter((r) => r.includes("/settings")).length).toBe(1);
		}
	});

	test("maxVisibleRows caps the listed entries", () => {
		const many = Array.from({ length: 30 }, (_, i) => ({
			name: `cmd${i}`,
			description: `command number ${i}`,
		}));
		const view = invokeView({ query: "", activeIndex: 0, commands: many, width: 61, maxVisibleRows: 4 });
		const rows = renderedRows(view);
		expect(rows.filter((r) => r.startsWith("◆") || r.startsWith("○")).length).toBe(4);
		expect(rows.some((r) => r.includes("↓ 26 more"))).toBe(true);
	});

	test("the box does not overflow its own width once laid out by Ink", async () => {
		const width = 27;
		const h = renderInk(
			<CommandPalette
				isOpen
				onClose={() => {}}
				onExecute={() => {}}
				commands={LONG}
				width={width}
			/>,
			{ columns: 120, rows: 40 },
		);
		await h.settle();
		const lines = h.frame().split("\n").filter((l) => l.length > 0);
		expect(lines.length).toBeGreaterThan(3);
		for (const line of lines) {
			expect(stripAnsi(line).trimEnd().length).toBeLessThanOrEqual(width);
		}
		h.unmount();
	});
});

describe("palette owns the keystrokes while open (issue #2913)", () => {
	const ALL: CommandPaletteCommand[] = [
		{ name: "help", description: "Show available commands" },
		{ name: "kanban", description: "Toggle kanban board view" },
		{ name: "settings", description: "Open settings view" },
		{ name: "status", description: "Show session status" },
	];

	test("typed characters filter the list; Ctrl+U clears the filter", async () => {
		const h = renderInk(
			<CommandPalette
				isOpen
				onClose={() => {}}
				onExecute={() => {}}
				commands={ALL}
				width={60}
			/>,
			{ columns: 100, rows: 30 },
		);
		await h.settle();
		expect(h.frame()).toContain("/kanban");

		await h.type("s");
		await h.type("e");
		await h.type("t");
		await h.type("t");
		const filtered = h.frame();
		expect(filtered).toContain("» sett");
		expect(filtered).toContain("/settings");
		expect(filtered).not.toContain("/kanban");
		expect(filtered).not.toContain("/status");

		await h.type(ctrl("u"));
		const cleared = h.frame();
		expect(cleared).toContain("type to filter");
		expect(cleared).toContain("/kanban");
		h.unmount();
	});

	test("Enter closes first, then executes the highlighted command", async () => {
		const calls: string[] = [];
		const h = renderInk(
			<CommandPalette
				isOpen
				onClose={() => calls.push("close")}
				onExecute={(name) => calls.push(`exec:${name}`)}
				commands={ALL}
				width={60}
			/>,
		);
		await h.settle();
		await h.type("kan");
		await h.type("\r");
		expect(calls).toEqual(["close", "exec:kanban"]);
		h.unmount();
	});
});

describe("filterAndSortCommands", () => {
	test("empty query returns input order untouched", () => {
		const out = filterAndSortCommands(COMMANDS, "");
		expect(out.map((c) => c.name)).toEqual([
			"voice",
			"kanban",
			"predict",
			"voiceprint",
			"model",
		]);
	});

	test("matches name and description case-insensitively", () => {
		const out = filterAndSortCommands(COMMANDS, "VOICE");
		expect(out.map((c) => c.name)).toEqual(["voice", "voiceprint"]);
	});

	test("name prefix beats description-only match", () => {
		const cmds: CommandPaletteCommand[] = [
			{ name: "abc", description: "talks about voice tts" },
			{ name: "voiceprint", description: "diarisation" },
			{ name: "voice", description: "tts" },
		];
		const out = filterAndSortCommands(cmds, "voice");
		expect(out.map((c) => c.name)).toEqual(["voiceprint", "voice", "abc"]);
	});

	test("returns empty list when nothing matches", () => {
		expect(filterAndSortCommands(COMMANDS, "zzz")).toEqual([]);
	});
});

describe("Enter dispatch order (issue #2388)", () => {
	// We can't render the stateful CommandPalette without an Ink test
	// runtime, so we verify the contract at the source level: when Enter
	// fires, onClose() must be called BEFORE onExecute() so the palette's
	// useInput unmounts before any sub-flow's useInput (e.g. /resume,
	// /voice menu) mounts. Otherwise both handlers race on the next key.
	test("Enter handler calls onClose before onExecute", () => {
		const src = readFileSync(
			join(__dirname, "..", "CommandPalette.tsx"),
			"utf8",
		);
		const enterBlock = src
			.split("if (key.return) {")[1]
			?.split("return;")[0];
		expect(enterBlock).toBeDefined();
		const closeIdx = enterBlock!.indexOf("onClose()");
		const execIdx = enterBlock!.indexOf("onExecute(");
		expect(closeIdx).toBeGreaterThan(-1);
		expect(execIdx).toBeGreaterThan(-1);
		expect(closeIdx).toBeLessThan(execIdx);
	});
});

describe("computeWindow (palette scrolling)", () => {
	test("total <= visible returns the full range", () => {
		expect(computeWindow(5, 0, 10)).toEqual({ start: 0, end: 5 });
		expect(computeWindow(10, 4, 10)).toEqual({ start: 0, end: 10 });
	});

	test("active at index 0 with 50 total renders 0..9", () => {
		expect(computeWindow(50, 0, 10)).toEqual({ start: 0, end: 10 });
	});

	test("active at index 25 with 50 total renders 20..29 (centred)", () => {
		expect(computeWindow(50, 25, 10)).toEqual({ start: 20, end: 30 });
	});

	test("active at last index renders the last 10", () => {
		expect(computeWindow(50, 49, 10)).toEqual({ start: 40, end: 50 });
	});

	test("active near top stays anchored at 0 (no negative start)", () => {
		expect(computeWindow(50, 2, 10)).toEqual({ start: 0, end: 10 });
	});
});

describe("CommandPaletteView windowing markers", () => {
	const MANY: CommandPaletteCommand[] = Array.from({ length: 30 }, (_, i) => ({
		name: `cmd${i}`,
		description: `command number ${i}`,
	}));

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

	test("active at 0 of 30: no up marker, down marker shows 20 hidden", () => {
		const rendered = invokeView({ query: "", activeIndex: 0, commands: MANY });
		const text = flatten(rendered);
		expect(text).not.toMatch(/↑ \d+ more/);
		expect(text).toContain("↓ 20 more");
		// Active row visible
		expect(text).toContain("/cmd0");
		expect(text).toContain("/cmd9");
		expect(text).not.toContain("/cmd10");
	});

	test("active at 25 of 30: only up marker (window already at end)", () => {
		const rendered = invokeView({ query: "", activeIndex: 25, commands: MANY });
		const text = flatten(rendered);
		expect(text).toContain("↑ 20 more");
		expect(text).toContain("/cmd25");
		// 20..30 window means hiddenBelow=0, so no down marker line
		expect(text).not.toMatch(/↓ \d+ more/);
	});

	test("active at last index of 30: up marker only", () => {
		const rendered = invokeView({ query: "", activeIndex: 29, commands: MANY });
		const text = flatten(rendered);
		expect(text).toContain("↑ 20 more");
		expect(text).not.toMatch(/↓ \d+ more/);
		expect(text).toContain("/cmd29");
	});

	test("middle position with markers above AND below", () => {
		// 30 items, active at 12 -> half=5, start=7, end=17. Hidden above=7, below=13.
		const rendered = invokeView({ query: "", activeIndex: 12, commands: MANY });
		const text = flatten(rendered);
		expect(text).toContain("↑ 7 more");
		expect(text).toContain("↓ 13 more");
		expect(text).toContain("/cmd12");
	});

	test("legacy '+N more - refine query' hint is gone", () => {
		const rendered = invokeView({ query: "", activeIndex: 0, commands: MANY });
		const text = flatten(rendered);
		expect(text).not.toContain("refine query");
	});
});
