/**
 * Tests for detectTermPresetIntent (#4764): "run pi" opens the pi preset via
 * the /term path with zero model tokens; anything longer falls through.
 */
import { describe, expect, test } from "bun:test";
import { resolveTermCommand } from "../../../../packages/terminal-tab/command-resolver.js";
import { getPreset, listPresetIds } from "./external-agent-runner.js";
import { detectTermPresetIntent } from "./term-intent.js";

const ids = listPresetIds();
const presets = ids.map((id) => {
	const p = getPreset(id)!;
	return { id: p.id, label: p.label, command: p.command, preferWindow: p.preferWindow };
});

describe("detectTermPresetIntent", () => {
	test.each([
		["run pi", ["pi"]],
		["open pi", ["pi"]],
		["Run Pi.", ["pi"]],
		["start hermes", ["hermes"]],
		["please launch pi", ["pi"]],
		["launch pi in a tab", ["pi", "--in-tab"]],
		["open codex in a new terminal", ["codex", "--in-tab"]],
		["run 8gent", ["8gent"]],
	])("%p opens the preset", (input, args) => {
		expect(detectTermPresetIntent(input, ids)).toEqual(args);
	});

	test.each([
		"run pi on this repo and fix the tests",
		"run the tests",
		"pi is broken, why",
		"what is pi",
		"open the pi docs",
		"run pi -p hello",
		"/term pi",
		"",
	])("%p falls through to the model", (input) => {
		expect(detectTermPresetIntent(input, ids)).toBeNull();
	});

	test.each(["run aider", "open vim", "start nonsense"])(
		"unknown preset %p falls through",
		(input) => {
			expect(detectTermPresetIntent(input, ids)).toBeNull();
		},
	);

	test("the match resolves through the same /term resolver to the preset binary", () => {
		const args = detectTermPresetIntent("run pi", ids)!;
		const resolved = resolveTermCommand({ args, presets, platform: "linux" });
		expect(resolved.source).toBe("preset");
		expect(resolved.command).toBe("pi");
		expect(resolved.args).toEqual([]);
		expect(resolved.mode).toBe("in-tab");
	});
});
