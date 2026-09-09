/**
 * HeaderBar tests - V2 chrome is the only render mode.
 *
 * The planHeader cases pin #2921: at 100 columns the workspace segment
 * wrapped above the brand pill, and at 120 the branch lost to the path.
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import {
	HeaderBar,
	brandPillWidth,
	planHeader,
	statusClusterWidth,
	type HeaderBarProps,
} from "../HeaderBar";
import { headerMiddleWidth } from "../../lib/header-layout.js";

function render(props: HeaderBarProps): React.ReactElement {
	return (HeaderBar as (p: HeaderBarProps) => React.ReactElement)(props);
}

const base: HeaderBarProps = {
	updateAvailable: null,
	workspacePath: "/home/operator/8gent-code",
	branch: "feat/tui-v2-default",
	syncStatus: "in sync",
	micOn: false,
	approvalPending: false,
	localFirst: true,
	sessionTime: "1m 02",
	lilEightState: "idle",
};

// The live shape from the issue frame: a worktree path, a long branch,
// the version in the pill, a two-figure session clock.
const live: HeaderBarProps = {
	...base,
	version: "0.17.3",
	workspacePath: "/Users/operator/8gent-code/.claude/worktrees/agent-a8b0f5de5b64292c6",
	branch: "fix/header-rail-100-cols",
	syncStatus: "up to date",
	sessionTime: "2m 21s",
};

/** Columns the three header zones need side by side for a given plan. */
function occupied(props: HeaderBarProps): number {
	const plan = planHeader(props);
	return (
		brandPillWidth(props.version, props.updateAvailable) +
		headerMiddleWidth(plan.middle) +
		2 +
		statusClusterWidth(props, plan.compactHint)
	);
}

describe("HeaderBar", () => {
	test("exports the component", () => {
		expect(HeaderBar).toBeDefined();
		expect(typeof HeaderBar).toBe("function");
	});

	test("renders a top-level Box with full width", () => {
		const rendered = render(base);
		const props = rendered.props as { width: string; justifyContent: string };
		expect(props.width).toBe("100%");
		expect(props.justifyContent).toBe("space-between");
	});

	test("pill and status cluster never shrink and carry no fixed width", () => {
		type BoxProps = { flexShrink?: number; width?: number | string; children?: React.ReactNode };
		const rendered = render(live) as React.ReactElement<BoxProps>;
		const children = React.Children.toArray(rendered.props.children) as React.ReactElement<BoxProps>[];
		const [pill, , cluster] = children;
		expect(pill.props.flexShrink).toBe(0);
		expect(pill.props.width).toBeUndefined();
		expect(cluster.props.flexShrink).toBe(0);
		expect(cluster.props.width).toBeUndefined();
	});

	test("brand pill width matches the rendered pill from the issue frame", () => {
		// "│ 8gent Code. v0.17.3 │ The Infinite Gentleman │" is 48 cells.
		expect(brandPillWidth("0.17.3", null)).toBe(48);
	});

	test("toggles approval pending chip without crashing", () => {
		const off = render({ ...base, approvalPending: false });
		const on = render({ ...base, approvalPending: true });
		expect(off).toBeDefined();
		expect(on).toBeDefined();
	});

	test("at 100 columns nothing wraps and the branch survives", () => {
		const props = { ...live, width: 100 };
		const plan = planHeader(props);
		expect(plan.compactHint).toBe(true);
		expect(plan.middle.path).toBe("");
		expect(plan.middle.branch.startsWith("fix/header")).toBe(true);
		expect(occupied(props)).toBeLessThanOrEqual(100);
	});

	test("at 120 columns the whole branch beats the tail of the path", () => {
		const props = { ...live, width: 120 };
		const plan = planHeader(props);
		expect(plan.compactHint).toBe(false);
		expect(plan.middle.branch).toBe("fix/header-rail-100-cols");
		expect(occupied(props)).toBeLessThanOrEqual(120);
	});

	test("at 120 columns a short branch leaves room for a path slice", () => {
		const props = { ...live, branch: "main", width: 120 };
		const plan = planHeader(props);
		expect(plan.compactHint).toBe(false);
		expect(plan.middle.branch).toBe("main");
		expect(plan.middle.path.length).toBeGreaterThanOrEqual(12);
		expect(occupied(props)).toBeLessThanOrEqual(120);
	});

	test("at 140 columns a short branch shows path, branch and sync together", () => {
		const props = { ...live, branch: "main", width: 140 };
		const plan = planHeader(props);
		expect(plan.middle.branch).toBe("main");
		expect(plan.middle.sync).toBe("up to date");
		expect(plan.middle.path.length).toBeGreaterThanOrEqual(12);
		expect(occupied(props)).toBeLessThanOrEqual(140);
	});

	test("at 90 columns the row still fits in one line", () => {
		const props = { ...live, width: 90 };
		expect(occupied(props)).toBeLessThanOrEqual(90);
	});

	test("fits every width from the chrome minimum to 200, ask chip and mic on", () => {
		const busy = { ...live, micOn: true, approvalPending: true };
		// Pill + padding + compact cluster is the hard floor; below it the
		// middle is empty and the outer overflow clip trims the cluster.
		const floor = brandPillWidth(busy.version, busy.updateAvailable) + 2 + statusClusterWidth(busy, true);
		expect(floor).toBeLessThan(100);
		for (let width = 60; width <= 200; width++) {
			const props = { ...busy, width };
			const plan = planHeader(props);
			if (width < floor) {
				expect(plan.middle.branch).toBe("");
			} else {
				expect(occupied(props)).toBeLessThanOrEqual(width);
			}
		}
	});

	test("defaults to an 80 column plan when width is omitted", () => {
		const plan = planHeader(live);
		expect(plan.compactHint).toBe(true);
		expect(plan.middleAvailable).toBe(0);
		expect(plan.middle.branch).toBe("");
	});

	test("snapshot across mic / ask / state matrix is stable", () => {
		const matrix = [
			{ ...base },
			{ ...base, micOn: true },
			{ ...base, approvalPending: true },
			{ ...base, localFirst: false },
			{ ...base, lilEightState: "working" as const },
			{ ...base, lilEightState: "error" as const },
		].map((cfg, idx) => {
			const rendered = render(cfg);
			const top = rendered.props as { width: string; justifyContent: string };
			return {
				idx,
				width: top.width,
				justifyContent: top.justifyContent,
				micOn: cfg.micOn,
				approvalPending: cfg.approvalPending,
				localFirst: cfg.localFirst,
				lilEightState: cfg.lilEightState,
			};
		});
		expect(matrix).toMatchSnapshot();
	});
});
