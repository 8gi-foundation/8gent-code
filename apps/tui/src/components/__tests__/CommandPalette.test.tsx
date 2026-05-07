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
import React from "react";
import {
	CommandPalette,
	CommandPaletteView,
	type CommandPaletteCommand,
	type CommandPaletteViewProps,
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
