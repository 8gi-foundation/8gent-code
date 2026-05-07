/**
 * LilEightBadge tests - structural snapshot across all 6 states.
 *
 * Follows the existing TUI test pattern in apps/tui/src/__tests__/smoke.test.ts:
 * we use bun:test (no ink-testing-library available in the workspace) and
 * inspect the React element tree directly. For a pure presentational
 * component this is the smallest thing that proves the contract: each state
 * renders without crashing, the border + label colors shift per state, and
 * the structure stays stable.
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import { LilEightBadge, type LilEightState } from "../LilEightBadge";
import { t } from "../../theme.js";

const STATES: LilEightState[] = ["idle", "thinking", "working", "done", "error", "sleep"];

const expectedColor: Record<LilEightState, string> = {
	idle:     t.muted,
	thinking: t.teal,
	working:  t.orange,
	done:     t.green,
	error:    t.red,
	sleep:    t.dim,
};

describe("LilEightBadge", () => {
	test("exports the component and the state type", () => {
		expect(LilEightBadge).toBeDefined();
		expect(typeof LilEightBadge).toBe("function");
	});

	for (const state of STATES) {
		test(`renders for state "${state}"`, () => {
			const element = React.createElement(LilEightBadge, { state }) as React.ReactElement<{
				state: LilEightState;
			}>;
			expect(element).toBeDefined();
			expect(element.props.state).toBe(state);

			// Invoke the component to get its rendered tree without a full Ink renderer.
			// LilEightBadge is a pure function of props so this is safe.
			const rendered = (LilEightBadge as (p: { state: LilEightState }) => React.ReactElement)({
				state,
			});
			expect(rendered).toBeDefined();
			// Top-level Box carries the state-mapped border color.
			expect((rendered.props as { borderColor: string }).borderColor).toBe(expectedColor[state]);
		});
	}

	test("snapshot of all 6 states is stable", () => {
		const tree = STATES.map((state) => {
			const rendered = (LilEightBadge as (p: { state: LilEightState }) => React.ReactElement)({
				state,
			});
			const props = rendered.props as {
				borderStyle: string;
				borderColor: string;
				paddingX: number;
				flexShrink: number;
			};
			return {
				state,
				borderStyle: props.borderStyle,
				borderColor: props.borderColor,
				paddingX: props.paddingX,
				flexShrink: props.flexShrink,
			};
		});
		expect(tree).toMatchSnapshot();
	});
});
