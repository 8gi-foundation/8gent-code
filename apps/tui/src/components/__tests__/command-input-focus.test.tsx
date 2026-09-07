/**
 * CommandInput key routing (issue #2913).
 *
 * The chat input is backed by ink-text-input, which owns its own key
 * listener. It used to be rendered without `focus`, so it kept accepting
 * keystrokes while the Ctrl+P palette was open (the parent Box was only
 * display:none). It also inserted the letter of every Ctrl chord as text,
 * which is how "=upsett/qui" ended up submitted to the model.
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import { CommandInput, slashHelpColumns } from "../command-input";
import { ctrl, renderInk } from "./ink-harness";

const NOOP = () => {};

describe("CommandInput focus", () => {
	test("focused=false: typed characters never reach the input", async () => {
		const h = renderInk(
			<CommandInput onSubmit={NOOP} isProcessing={false} focused={false} showAnimations={false} />,
			{ columns: 100, rows: 30 },
		);
		await h.settle();
		await h.type("s");
		await h.type("e");
		await h.type("t");
		await h.type("t");
		const frame = h.frame();
		expect(frame).not.toContain("sett");
		expect(frame).toContain("Type a command or ask a question...");
		h.unmount();
	});

	test("focused=true: typed characters appear; Ctrl+U clears the line", async () => {
		const h = renderInk(
			<CommandInput onSubmit={NOOP} isProcessing={false} focused showAnimations={false} />,
			{ columns: 100, rows: 30 },
		);
		await h.settle();
		await h.type("h");
		await h.type("e");
		await h.type("l");
		await h.type("l");
		await h.type("o");
		expect(h.frame()).toContain("hello");

		await h.type(ctrl("u"));
		const cleared = h.frame();
		expect(cleared).not.toContain("hello");
		expect(cleared).toContain("Type a command or ask a question...");
		h.unmount();
	});

	test("a Ctrl chord (Ctrl+P) does not leave its letter in the line", async () => {
		const h = renderInk(
			<CommandInput onSubmit={NOOP} isProcessing={false} focused showAnimations={false} />,
			{ columns: 100, rows: 30 },
		);
		await h.settle();
		await h.type("a");
		await h.type("b");
		await h.type(ctrl("p"));
		await h.type(ctrl("n"));
		const frame = h.frame();
		expect(frame).toContain("ab");
		expect(frame).not.toContain("abp");
		expect(frame).not.toContain("abn");
		h.unmount();
	});

	test("submitted text is exactly what was typed", async () => {
		const sent: string[] = [];
		const h = renderInk(
			<CommandInput
				onSubmit={(v) => sent.push(v)}
				isProcessing={false}
				focused
				showAnimations={false}
			/>,
			{ columns: 100, rows: 30 },
		);
		await h.settle();
		await h.type("hi");
		await h.type(ctrl("p"));
		await h.type("\r");
		expect(sent).toEqual(["hi"]);
		h.unmount();
	});
});

describe("slash help columns", () => {
	const names = ["knowledge", "settings", "billiondollarboardroom"];

	test("name + description fit the inner width at 25 and 59 columns", () => {
		for (const width of [25, 59]) {
			const cols = slashHelpColumns(width, names);
			expect(cols.inner).toBe(width - 4);
			if (cols.description > 0) {
				expect(cols.name + 1 + cols.description).toBeLessThanOrEqual(cols.inner);
			}
		}
	});

	test("very long names are capped so the description column survives", () => {
		const cols = slashHelpColumns(59, names);
		expect(cols.name).toBeLessThanOrEqual(16);
		expect(cols.description).toBeGreaterThan(0);
	});
});
