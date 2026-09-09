/**
 * Contract tests for the V2 shell width budget (#2938). The chat column
 * comes first: it keeps at least CHAT_MIN_COLS while any rail is shown,
 * the activity rail appears only when that still holds, and the context
 * rail plus plan column only when it holds with both rails placed.
 */

import { describe, expect, test } from "bun:test";
import {
	ACTIVITY_RAIL_COLS,
	CHAT_MIN_COLS,
	CONTEXT_RAIL_COLS,
	SHELL_CHROME_COLS,
	shellWidthBudget,
} from "./layout.js";

describe("shellWidthBudget", () => {
	const table: Array<{
		cols: number;
		showContextRail: boolean;
		showActivityRail: boolean;
		chatWidth: number;
	}> = [
		{ cols: 80, showContextRail: false, showActivityRail: false, chatWidth: 72 },
		{ cols: 100, showContextRail: false, showActivityRail: false, chatWidth: 92 },
		{ cols: 104, showContextRail: false, showActivityRail: true, chatWidth: 60 },
		{ cols: 120, showContextRail: false, showActivityRail: true, chatWidth: 76 },
		{ cols: 140, showContextRail: false, showActivityRail: true, chatWidth: 96 },
		{ cols: 160, showContextRail: true, showActivityRail: true, chatWidth: 61 },
		{ cols: 180, showContextRail: true, showActivityRail: true, chatWidth: 81 },
	];

	for (const row of table) {
		test(`${row.cols} columns`, () => {
			expect(shellWidthBudget(row.cols)).toEqual({
				showContextRail: row.showContextRail,
				showActivityRail: row.showActivityRail,
				chatWidth: row.chatWidth,
			});
		});
	}

	test("chat never drops below the minimum while a rail is showing", () => {
		for (let cols = 40; cols <= 300; cols++) {
			const b = shellWidthBudget(cols);
			if (b.showActivityRail || b.showContextRail) {
				expect(b.chatWidth).toBeGreaterThanOrEqual(CHAT_MIN_COLS);
			}
		}
	});

	test("context rail never shows without the activity rail", () => {
		for (let cols = 40; cols <= 300; cols++) {
			const b = shellWidthBudget(cols);
			if (b.showContextRail) expect(b.showActivityRail).toBe(true);
		}
	});

	test("rails drop in order as the terminal narrows: context first, then activity", () => {
		const bothFrom = SHELL_CHROME_COLS + ACTIVITY_RAIL_COLS + CONTEXT_RAIL_COLS + CHAT_MIN_COLS;
		const activityFrom = SHELL_CHROME_COLS + ACTIVITY_RAIL_COLS + CHAT_MIN_COLS;
		expect(bothFrom).toBe(159);
		expect(activityFrom).toBe(104);
		expect(shellWidthBudget(bothFrom).showContextRail).toBe(true);
		expect(shellWidthBudget(bothFrom - 1)).toMatchObject({
			showContextRail: false,
			showActivityRail: true,
		});
		expect(shellWidthBudget(activityFrom).showActivityRail).toBe(true);
		expect(shellWidthBudget(activityFrom - 1)).toMatchObject({
			showContextRail: false,
			showActivityRail: false,
		});
	});

	test("the chat width matches the chrome and rail arithmetic exactly", () => {
		expect(shellWidthBudget(200).chatWidth).toBe(
			200 - SHELL_CHROME_COLS - CONTEXT_RAIL_COLS - ACTIVITY_RAIL_COLS,
		);
		expect(shellWidthBudget(120).chatWidth).toBe(120 - SHELL_CHROME_COLS - ACTIVITY_RAIL_COLS);
		expect(shellWidthBudget(90).chatWidth).toBe(90 - SHELL_CHROME_COLS);
	});

	test("tiny terminals keep a readable floor with no rails", () => {
		expect(shellWidthBudget(20)).toEqual({
			showContextRail: false,
			showActivityRail: false,
			chatWidth: 24,
		});
	});
});
