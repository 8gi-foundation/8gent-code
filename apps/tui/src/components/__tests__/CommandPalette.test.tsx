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
import {
	CommandPalette,
	CommandPaletteView,
	type CommandPaletteCommand,
	type CommandPaletteViewProps,
	computeWindow,
	filterAndSortCommands,
} from "../CommandPalette";

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
		].map((row) => {
			const rendered = invokeView({
				query: row.query,
				activeIndex: row.activeIndex,
				commands: row.commands,
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
			};
		});

		expect(matrix).toMatchSnapshot();
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
